/**
 * Trace header test.
 *
 * Tests buildTraceHeader() — the pure function that produces the first line of
 * an exported debug trace. It takes pre-gathered plain data and returns the
 * header with no Obsidian I/O (no vault writes, no Notice).
 *
 * The exported file is meant to be read by a maintainer or an LLM with no
 * access to this repository, so the header must be self-describing as well as
 * safe.
 *
 * Invariants tested:
 *   Redacted (the default — an export that says nothing gets the safe one):
 *     - serverHost / vaultId / deviceName are "(redacted)"
 *     - tokenConfigured is a bare boolean: no prefix, no length
 *     - known vault paths do not appear anywhere in the serialised header
 *     - pathDirectory is withheld
 *     - full content hashes are truncated, prefix kept for correlation
 *     - leakDetected is false when redaction works, true when a path survives
 *
 *   With filenames (redacted: false):
 *     - serverHost / vaultId / deviceName ARE present
 *     - pathDirectory maps every pathId back to its real path
 *     - leakDetected is false (passthrough redactor, no check performed)
 *
 *   Always:
 *     - the header identifies itself (recordType, format version, readme)
 *     - the pathId scheme is described well enough to merge two traces
 *     - a null state still produces a valid header
 *
 * This test is intentionally Obsidian-free. It uses a real SHA-256
 * implementation via Node's webcrypto.
 */

import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") {
	globalThis.crypto = webcrypto as unknown as Crypto;
}

// Import from the pure module directly — no Obsidian imports, no ConfirmModal.
import {
	buildTraceHeader,
	TRACE_HEADER_FORMAT_VERSION,
	type TraceHeaderInput,
	type TraceHeaderStateInput,
	type TraceHeaderTraceFacts,
} from "../../src/telemetry/diagnostics/diagnosticsBundle";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

// ── SHA-256 via Node webcrypto ─────────────────────────────────────────────────

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Fake input with known sensitive values ────────────────────────────────────

const SENSITIVE_HOST      = "https://my-secret-worker.workers.dev";
const SENSITIVE_VAULT     = "vault-id-abc123";
const SENSITIVE_DEVICE    = "kavin-macbook-pro";
const KNOWN_PATH_1        = "Projects/secret-plan.md";
const KNOWN_PATH_2        = "Inbox/private-note.md";
// Path that only appears in the server trace — NOT in diskHashes or crdtHashes.
// This exercises the regex-based redactor path for unseeded paths in free-form
// log messages (not known-path key redaction).
const SERVER_TRACE_ONLY_PATH = "Attachments/private-image.png";
const HISTORICAL_EVENT_ONLY_PATH = "Deleted Medical Notes/old-result.md";
const STRUCTURED_TRACE_ONLY_PATH = "Archive/structured-secret.md";
const CONFLICT_PATH = "Notes/important (YAOS conflict from Laptop 2026-05-11T12-00-00Z).md";
const NORMALIZED_PATH = "Notes/some-file.md";
const FULL_CONTENT_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const PATH_ID_1 = "p:1111111111111111111111111111111a";
const PATH_ID_2 = "p:2222222222222222222222222222222b";

function makeTrace(overrides: Partial<TraceHeaderTraceFacts> = {}): TraceHeaderTraceFacts {
	return {
		traceId: "trace-test-001",
		bootId: "boot-test-001",
		deviceId: "device-test-001",
		vaultIdHash: "a".repeat(64),
		serverHostHash: "b".repeat(64),
		pluginVersion: "1.6.1",
		flightEventSchemaVersion: 2,
		flightEventTaxonomyVersion: 3,
		exportedAt: "2026-05-10T00:00:05.000Z",
		eventCount: 12,
		segmentCount: 1,
		segmentsRotated: false,
		pathIdentityDegraded: false,
		droppedEventCount: 0,
		droppedEventCountByKind: {},
		pathPseudonymSaltFingerprint: "f".repeat(32),
		pathDirectory: [
			{ pathId: PATH_ID_1, path: KNOWN_PATH_1 },
			{ pathId: PATH_ID_2, path: KNOWN_PATH_2 },
		],
		...overrides,
	};
}

function makeState(overrides: Partial<TraceHeaderStateInput> = {}): TraceHeaderStateInput {
	const diskHashes = new Map<string, { hash: string; length: number }>([
		[KNOWN_PATH_1, { hash: "abc123", length: 42 }],
		[KNOWN_PATH_2, { hash: "def456", length: 100 }],
	]);
	const crdtHashes = new Map<string, { hash: string; length: number }>([
		[KNOWN_PATH_1, { hash: "abc123", length: 42 }],
	]);

	return {
		generatedAt: "2026-05-10T00:00:00.000Z",
		generationDurationMs: 123,
		platform: {
			obsidianApiVersion: "1.8.7",
			operatingSystem: "darwin",
			isMobile: false,
			isDesktopApp: true,
		},
		serverVersion: "2026.05.01",
		settings: {
			host: SENSITIVE_HOST,
			token: "secret-token",
			vaultId: SENSITIVE_VAULT,
			deviceName: SENSITIVE_DEVICE,
			debug: true,
			enableAttachmentSync: false,
			externalEditPolicy: "always",
		},
		syncState: {
			reconcileCompleted: true,
			reconcileInFlight: false,
			reconcilePending: false,
			lastReconcileStats: null,
			awaitingFirstProviderSyncAfterStartup: false,
			lastReconciledGeneration: 1,
			connectedToServer: true,
			providerSynced: true,
			localCacheReady: true,
			connectionGeneration: 1,
			fatalAuthError: false,
			fatalAuthCode: null,
			fatalAuthDetails: null,
			indexedDbError: false,
			indexedDbErrorDetails: null,
			serverReceiptStartupValidation: "validated",
			serverReceiptEchoCounters: {
				customMessageSeenCount: 0,
				svEchoSeenCount: 0,
				acceptedCount: 0,
				rejectedCount: 0,
			},
			activeCrdtPathCount: 2,
			blobPathCount: 0,
			syncableMarkdownFileCountOnDisk: 2,
			openFileCount: 1,
			documentSchemaVersionSupportedByClient: 2,
			documentSchemaVersionStoredInDocument: 2,
		},
		syncFacts: {
			headlineState: "online",
			serverReachable: true,
			authAccepted: true,
			websocketOpen: true,
			lastAuthRejectCode: null,
			lastLocalUpdateAt: null,
			lastLocalUpdateWhileConnectedAt: null,
			lastRemoteUpdateAt: null,
			pendingLocalCount: null,
			pendingBlobUploads: 0,
		},
		httpTraceContext: null,
		diskHashes,
		crdtHashes,
		pluginLogLines: [
			{ ts: "2026-05-10T00:00:00.000Z", msg: `synced "${KNOWN_PATH_1}"` },
			{ ts: "2026-05-10T00:00:01.000Z", msg: `failed to read "${HISTORICAL_EVENT_ONLY_PATH}"` },
		],
		syncLogLines: [],
		serverTraceEvents: [
			// Path only in the server trace — not in diskHashes/crdtHashes.
			{ event: "blob-synced", msg: `blob uploaded: "${SERVER_TRACE_ONLY_PATH}"` },
			{
				source: "reconcile",
				msg: "reconcile-safety-brake-blocked",
				details: {
					affectedPathSample: [STRUCTURED_TRACE_ONLY_PATH],
					blockedUpdatePathSample: [STRUCTURED_TRACE_ONLY_PATH],
					hash: FULL_CONTENT_HASH,
					diskHashBefore: FULL_CONTENT_HASH,
				},
			},
			{
				source: "conflict",
				msg: "conflict-artifact-needed",
				details: {
					path: KNOWN_PATH_1,
					conflictPath: CONFLICT_PATH,
					normalizedPath: NORMALIZED_PATH,
					reason: "bound-file-ambiguous-divergence",
				},
			},
		],
		openFiles: [
			{ path: KNOWN_PATH_1, status: "open" },
		],
		diskMirrorSnapshot: { observedPaths: [KNOWN_PATH_1] },
		blobSyncSnapshot: null,
		frontmatterQuarantine: [],
		sha256Hex,
		...overrides,
	};
}

function makeInput(overrides: Partial<TraceHeaderInput> = {}): TraceHeaderInput {
	return { trace: makeTrace(), state: makeState(), ...overrides };
}

// ── Test 0: server receipt startup validation is explained in prose ──────────

console.log("\n--- Test 0: server receipt startup validation detail ---");
{
	const { header } = await buildTraceHeader(makeInput({
		state: makeState({
			syncState: {
				...makeState().syncState,
				serverReceiptStartupValidation: "skipped_local_yjs_timeout",
			},
		}),
	}));
	const syncState = header.syncState as Record<string, unknown>;
	assert(
		syncState.serverReceiptStartupValidationExplanation ===
			"skipped: local Yjs cache did not finish loading; persisted receipt candidate was not trusted this session",
		"header explains that skipped startup validation means the persisted candidate was not trusted",
	);
}

// ── Test 1: redaction is the default ─────────────────────────────────────────

console.log("\n--- Test 1: redaction is opt-out, not opt-in ---");
{
	const { header } = await buildTraceHeader(makeInput());
	const settings = header.settingsSnapshot as Record<string, unknown>;

	assert(header.redacted === true, "an export that passes no options is redacted");
	assert(settings.serverHost === "(redacted)", "default: serverHost is (redacted)");
	assert(
		!JSON.stringify(header).includes(KNOWN_PATH_1),
		"default: known vault paths are absent",
	);
}

// ── Test 2: redacted — sensitive settings are withheld ───────────────────────

console.log("\n--- Test 2: redacted — settings snapshot ---");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });
	const settings = header.settingsSnapshot as Record<string, unknown>;

	assert(settings.serverHost === "(redacted)", "redacted: serverHost is (redacted)");
	assert(settings.vaultId === "(redacted)", "redacted: vaultId is (redacted)");
	assert(settings.deviceName === "(redacted)", "redacted: deviceName is (redacted)");
	assert(settings.tokenConfigured === true, "redacted: tokenConfigured is a bare boolean");
	assert(
		!JSON.stringify(settings).includes("secret-token"),
		"redacted: the token value itself never appears",
	);
	assert(settings.debugModeEnabled === true, "settings snapshot records that debug was on");
	assert(
		settings.externalEditPolicy === "always",
		"settings snapshot keeps non-sensitive policy values verbatim",
	);
}

// ── Test 3: redacted — known vault paths do not appear ───────────────────────

console.log("\n--- Test 3: redacted — vault paths absent ---");
{
	const { header, leakDetected } = await buildTraceHeader(makeInput(), { redacted: true });
	const serialized = JSON.stringify(header);

	assert(!serialized.includes(KNOWN_PATH_1), `redacted: "${KNOWN_PATH_1}" not in header`);
	assert(!serialized.includes(KNOWN_PATH_2), `redacted: "${KNOWN_PATH_2}" not in header`);
	assert(!leakDetected, "redacted: leakDetected is false when paths are redacted");
	assert(header.pathDirectory === null, "redacted: pathDirectory is withheld");
}

// ── Test 4: redacted — host/vault/device not in serialized header ────────────

console.log("\n--- Test 4: redacted — server URL, vault ID, device name absent ---");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });
	const serialized = JSON.stringify(header);

	assert(!serialized.includes(SENSITIVE_HOST), "redacted: server URL not in header");
	assert(!serialized.includes(SENSITIVE_VAULT), "redacted: vault ID not in header");
	assert(!serialized.includes(SENSITIVE_DEVICE), "redacted: device name not in header");
}

// ── Test 5: the header is self-describing ────────────────────────────────────

console.log("\n--- Test 5: header identifies itself to a reader with no repo access ---");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });

	assert(header.recordType === "trace-header", "header declares recordType");
	assert(
		header.traceHeaderFormatVersion === TRACE_HEADER_FORMAT_VERSION,
		"header declares its own format version",
	);
	assert(
		typeof header.readme === "string" && (header.readme as string).includes("seq"),
		"readme explains the NDJSON layout and the causal seq ordering",
	);

	const versions = header.versions as Record<string, unknown>;
	assert(versions.pluginVersion === "1.6.1", "versions carry the plugin version");
	assert(versions.serverVersion === "2026.05.01", "versions carry the server version");
	assert(
		versions.documentSchemaVersionSupportedByClient === 2 &&
			versions.documentSchemaVersionStoredInDocument === 2,
		"versions carry both document schema versions",
	);
	assert(
		versions.flightEventSchemaVersion === 2 && versions.flightEventTaxonomyVersion === 3,
		"versions carry the event schema and taxonomy versions",
	);

	const platform = header.platform as Record<string, unknown>;
	assert(platform.operatingSystem === "darwin" && platform.isMobile === false, "platform is reported");

	const contents = header.traceContents as Record<string, unknown>;
	assert(contents.eventCount === 12, "traceContents reports how many events follow");
	assert(contents.droppedEventCount === 0, "traceContents reports dropped events");
}

// ── Test 6: the pathId namespace is described well enough to merge traces ────

console.log("\n--- Test 6: pathId namespace is self-describing ---");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });

	const identity = header.traceIdentity as Record<string, unknown>;
	assert(identity.traceId === "trace-test-001", "traceIdentity carries the traceId");
	assert(
		identity.pathPseudonymSaltFingerprint === "f".repeat(32),
		"traceIdentity publishes the salt fingerprint so two traces can be matched",
	);

	const scheme = header.pathPseudonymization as Record<string, unknown>;
	assert(
		typeof scheme.scheme === "string" && (scheme.scheme as string).includes("sha256"),
		"the pseudonymization scheme is spelled out",
	);
	assert(scheme.saltScope === "vault", "the salt scope is stated as vault");
	assert(
		scheme.stableAcrossDevicesOfSameVault === true,
		"the header states that pathIds correlate across devices of one vault",
	);
}

// ── Test 7: leak detection fires when a path survives redaction ──────────────

console.log("\n--- Test 7: leakDetected fires on a real redaction escape ---");
{
	// The deep walker redacts string *values*. A vault path used as an object
	// *key* slips through — which is exactly the structural escape the
	// post-redaction check exists to catch.
	const leaky = makeInput({
		state: makeState({
			blobSyncSnapshot: { [KNOWN_PATH_1]: { pendingBytes: 12 } },
		}),
	});

	const { header, leakDetected } = await buildTraceHeader(leaky, { redacted: true });
	assert(
		JSON.stringify(header).includes(KNOWN_PATH_1),
		"precondition: a path used as an object key survives the deep walker",
	);
	assert(leakDetected, "leakDetected is true when a known path survives into the header");

	const { leakDetected: cleanRun } = await buildTraceHeader(makeInput(), { redacted: true });
	assert(!cleanRun, "leakDetected is false on a correctly redacted header");

	const { leakDetected: unredactedRun } = await buildTraceHeader(makeInput(), { redacted: false });
	assert(!unredactedRun, "with filenames: no leak check is performed, so leakDetected is false");
}

// ── Test 8: with filenames — sensitive fields ARE present ────────────────────

console.log("\n--- Test 8: with filenames — settings and directory included ---");
{
	const { header } = await buildTraceHeader(makeInput(), { redacted: false });
	const settings = header.settingsSnapshot as Record<string, unknown>;
	const serialized = JSON.stringify(header);

	assert(header.redacted === false, "header records that it is not redacted");
	assert(settings.serverHost === SENSITIVE_HOST, "with filenames: serverHost is present");
	assert(settings.vaultId === SENSITIVE_VAULT, "with filenames: vaultId is present");
	assert(settings.deviceName === SENSITIVE_DEVICE, "with filenames: deviceName is present");
	assert(serialized.includes(KNOWN_PATH_1), `with filenames: "${KNOWN_PATH_1}" is present`);

	const directory = header.pathDirectory as Array<{ pathId: string; path: string }>;
	assert(Array.isArray(directory) && directory.length === 2, "with filenames: pathDirectory is included");
	assert(
		directory.some((e) => e.pathId === PATH_ID_1 && e.path === KNOWN_PATH_1),
		"pathDirectory maps each pathId back to its real vault path",
	);
}

// ── Test 9: vault vs CRDT comparison counts ──────────────────────────────────

console.log("\n--- Test 9: vault vs CRDT comparison ---");
{
	// KNOWN_PATH_2 is in diskHashes but not crdtHashes → missing in CRDT.
	const { header, missingOnDiskCount, missingInCrdtCount, hashMismatchCount } =
		await buildTraceHeader(makeInput(), { redacted: true });
	const comparison = header.vaultVersusCrdtComparison as Record<string, unknown>;

	assert(missingInCrdtCount === 1, "one path missing in CRDT (KNOWN_PATH_2)");
	assert(missingOnDiskCount === 0, "no paths missing on disk");
	assert(hashMismatchCount === 0, "no hash mismatches (KNOWN_PATH_1 matches)");
	assert(comparison.comparedFileCount === 2, "comparedFileCount is 2");
	assert(comparison.matchingFileCount === 1, "matchingFileCount is 1");

	const missing = comparison.filesMissingInCrdt as Array<Record<string, unknown>>;
	assert(missing.length === 1, "filesMissingInCrdt has one entry");
	assert(
		missing[0]?.pathId === PATH_ID_2 && missing[0]?.path === undefined,
		"redacted comparison entries carry the pathId only, joinable against the event lines",
	);

	const { header: fullHeader } = await buildTraceHeader(makeInput(), { redacted: false });
	const fullMissing = (fullHeader.vaultVersusCrdtComparison as Record<string, unknown>)
		.filesMissingInCrdt as Array<Record<string, unknown>>;
	assert(
		fullMissing[0]?.path === KNOWN_PATH_2,
		"with filenames: comparison entries also carry the real path",
	);
}

// ── Test 10: unseeded paths in free-form text are redacted by regex ──────────

console.log("\n--- Test 10: redacted — unseeded paths in log text ---");
{
	// SERVER_TRACE_ONLY_PATH appears in the server trace as a quoted path string
	// but is NOT in diskHashes or crdtHashes. Known-path seeding will not cover
	// it; the regex redactor must catch it.
	const { header } = await buildTraceHeader(makeInput(), { redacted: true });
	const serialized = JSON.stringify(header);

	assert(
		!serialized.includes(SERVER_TRACE_ONLY_PATH),
		`redacted: unseeded server trace path "${SERVER_TRACE_ONLY_PATH}" not in header`,
	);
	assert(
		!serialized.includes(HISTORICAL_EVENT_ONLY_PATH),
		`redacted: stale historical log path "${HISTORICAL_EVENT_ONLY_PATH}" not in header`,
	);
	assert(
		!serialized.includes(STRUCTURED_TRACE_ONLY_PATH),
		`redacted: structured trace path sample "${STRUCTURED_TRACE_ONLY_PATH}" not in header`,
	);
	assert(
		!serialized.includes(CONFLICT_PATH),
		`redacted: conflictPath "${CONFLICT_PATH}" not in header`,
	);
	assert(
		!serialized.includes(NORMALIZED_PATH),
		`redacted: normalizedPath "${NORMALIZED_PATH}" not in header`,
	);
	assert(
		!serialized.includes(FULL_CONTENT_HASH),
		"redacted: full content hashes are truncated",
	);
	assert(
		serialized.includes(`${FULL_CONTENT_HASH.slice(0, 12)}…`),
		"redacted: content hash prefix remains for correlation",
	);

	const { header: fullHeader } = await buildTraceHeader(makeInput(), { redacted: false });
	const fullSerialized = JSON.stringify(fullHeader);
	assert(
		fullSerialized.includes(SERVER_TRACE_ONLY_PATH),
		`with filenames: unseeded server trace path "${SERVER_TRACE_ONLY_PATH}" is present`,
	);
	assert(
		fullSerialized.includes(HISTORICAL_EVENT_ONLY_PATH),
		`with filenames: stale historical log path "${HISTORICAL_EVENT_ONLY_PATH}" is present`,
	);
	assert(
		fullSerialized.includes(STRUCTURED_TRACE_ONLY_PATH),
		`with filenames: structured trace path sample "${STRUCTURED_TRACE_ONLY_PATH}" is present`,
	);
	assert(
		fullSerialized.includes(CONFLICT_PATH),
		`with filenames: conflictPath "${CONFLICT_PATH}" is present`,
	);
	assert(
		fullSerialized.includes(NORMALIZED_PATH),
		`with filenames: normalizedPath "${NORMALIZED_PATH}" is present`,
	);
	assert(
		fullSerialized.includes(FULL_CONTENT_HASH),
		"with filenames: full content hashes are present",
	);
}

// ── Test 11: a trace exported before sync initialised still has a header ─────

console.log("\n--- Test 11: null state still produces a usable header ---");
{
	const { header, leakDetected } = await buildTraceHeader({ trace: makeTrace(), state: null });

	assert(header.syncStateAvailable === false, "header says outright that sync state is unavailable");
	assert(header.settingsSnapshot === null, "settingsSnapshot is null rather than invented");
	assert(header.syncState === null, "syncState is null rather than invented");
	assert(header.vaultVersusCrdtComparison === null, "comparison is null rather than invented");
	assert(header.recordType === "trace-header", "header is still self-identifying");
	assert(header.generatedAt === "2026-05-10T00:00:05.000Z", "generatedAt falls back to exportedAt");
	assert(!leakDetected, "no state means no known paths and no leak");
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
