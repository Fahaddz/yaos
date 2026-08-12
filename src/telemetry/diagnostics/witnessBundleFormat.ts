export type WitnessCheckpointSegment = {
	index: number;
	content: string;
};

export type SafeWitnessBundleInput = {
	pluginVersion: string;
	deviceId: string;
	localTraceId: string;
	platform: "desktop" | "ios" | "android" | "unknown";
	runtimeState: string;
	flightMode: string;
	qaTraceSecretHash: string;
	scenarioRunId?: string | null;
	scenarioId?: string | null;
	segments: ReadonlyArray<WitnessCheckpointSegment>;
	createdAt?: string;
};

export type SafeWitnessBundleResult = {
	bundle: string;
	eventCount: number;
	droppedUnsafeLineCount: number;
};

export type ClipboardWriter = {
	writeText(text: string): Promise<void>;
};

const SAFE_WITNESS_KINDS = new Set([
	"device.witness.settled",
	"device.witness.diverged",
]);

const SAFE_DATA_KEYS = new Set([
	"authority",
	"causedByEvents",
	"crdtHash",
	"diskHash",
	"diskMatchesCrdt",
	"editorHash",
	"editorMatchesCrdt",
	"editorSampleKind",
	"fileOpen",
	"lastDiskWriteAt",
	"lastLocalEditAt",
	"lastRecoveryAt",
	"lastRemoteApplyAt",
	"originClass",
	"precisionPath",
	"priorLatestSeq",
	"priorLatestStateHash",
	"reason",
	"recoveryStateHash",
	"runtimeState",
	"scenarioId",
	"scenarioRunId",
	"scenarioStepIndex",
	"stableAfterMs",
	"stateHash",
	"stateKind",
	"suppressedReason",
]);

const SAFE_CAUSED_BY_EVENT_KEYS = new Set([
	"lastConflictArtifactSeq",
	"lastCrdtUpdateSeq",
	"lastDiskWriteSeq",
	"lastRecoverySeq",
	"lastRemoteApplySeq",
	"lastTombstoneSeq",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeScalar(value: unknown): value is string | number | boolean | null {
	return value === null || typeof value === "string" || typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value));
}

function sanitizeCausedByEvents(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const result: Record<string, number> = {};
	for (const key of SAFE_CAUSED_BY_EVENT_KEYS) {
		const candidate = value[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) result[key] = candidate;
	}
	return result;
}

function sanitizeWitnessData(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const result: Record<string, unknown> = {};
	for (const key of SAFE_DATA_KEYS) {
		const candidate = value[key];
		if (key === "causedByEvents") {
			result[key] = sanitizeCausedByEvents(candidate);
		} else if (isSafeScalar(candidate)) {
			result[key] = candidate;
		}
	}
	return result;
}

function sanitizeCheckpointLine(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value) || typeof value.kind !== "string") return null;

	if (value.kind === "checkpoint.segment.header") {
		if (
			typeof value.traceId !== "string" ||
			typeof value.deviceId !== "string" ||
			typeof value.segmentIndex !== "number" ||
			typeof value.firstSeq !== "number"
		) {
			return null;
		}
		return {
			kind: "checkpoint.segment.header",
			traceId: value.traceId,
			deviceId: value.deviceId,
			segmentIndex: value.segmentIndex,
			firstSeq: value.firstSeq,
		};
	}

	if (!SAFE_WITNESS_KINDS.has(value.kind) || typeof value.seq !== "number") return null;
	const line: Record<string, unknown> = {
		kind: value.kind,
		seq: value.seq,
		fileId: typeof value.fileId === "string" ? value.fileId : null,
		data: sanitizeWitnessData(value.data),
	};
	if (typeof value.pathId === "string") line.pathId = value.pathId;
	return line;
}

function sanitizeSegment(segment: WitnessCheckpointSegment): {
	lines: string[];
	eventCount: number;
	droppedUnsafeLineCount: number;
} {
	const lines: string[] = [];
	let eventCount = 0;
	let droppedUnsafeLineCount = 0;

	for (const sourceLine of segment.content.split("\n")) {
		if (!sourceLine.trim()) continue;
		try {
			const sanitized = sanitizeCheckpointLine(JSON.parse(sourceLine));
			if (!sanitized) {
				droppedUnsafeLineCount++;
				continue;
			}
			if (SAFE_WITNESS_KINDS.has(String(sanitized.kind))) eventCount++;
			lines.push(JSON.stringify(sanitized));
		} catch {
			droppedUnsafeLineCount++;
		}
	}

	return { lines, eventCount, droppedUnsafeLineCount };
}

/**
 * Builds the safe NDJSON contract consumed by `qa:analyze-bundles`.
 *
 * Checkpoint lines are projected through an explicit allowlist. This keeps raw
 * paths, note content, tokens, and future unreviewed fields out of safe exports.
 */
export function buildSafeWitnessBundle(input: SafeWitnessBundleInput): SafeWitnessBundleResult {
	const sanitizedSegments = input.segments.map(sanitizeSegment);
	const eventCount = sanitizedSegments.reduce((total, segment) => total + segment.eventCount, 0);
	const droppedUnsafeLineCount = sanitizedSegments.reduce(
		(total, segment) => total + segment.droppedUnsafeLineCount,
		0,
	);
	const header = {
		kind: "bundle.header",
		bundleSchemaVersion: 1,
		createdAt: input.createdAt ?? new Date().toISOString(),
		pluginVersion: input.pluginVersion,
		deviceId: input.deviceId,
		deviceLabel: "(redacted)",
		platform: input.platform,
		runtimeState: input.runtimeState,
		localTraceId: input.localTraceId,
		scenarioRunId: input.scenarioRunId ?? null,
		scenarioId: input.scenarioId ?? null,
		qaTraceSecretHash: input.qaTraceSecretHash,
		flightMode: input.flightMode,
		eventCount,
		containsRawPaths: false,
		hashDomain: "witness-state-v1",
		privacyMode: "safe",
		droppedUnsafeLineCount,
	};
	const bodyLines = sanitizedSegments.flatMap((segment) => segment.lines);
	return {
		bundle: [JSON.stringify(header), ...bodyLines].join("\n") + "\n",
		eventCount,
		droppedUnsafeLineCount,
	};
}

/**
 * Attempts to copy a safe bundle without persisting it to the vault or plugin
 * data. Callers present their own fallback UI when copying is unavailable.
 */
export async function copyWitnessBundleToClipboard(
	bundle: string,
	clipboard: ClipboardWriter | null | undefined =
		typeof navigator === "undefined" ? undefined : navigator.clipboard,
): Promise<boolean> {
	if (!clipboard) return false;
	try {
		await clipboard.writeText(bundle);
		return true;
	} catch {
		return false;
	}
}
