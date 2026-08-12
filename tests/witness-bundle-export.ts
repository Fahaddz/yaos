/**
 * Verification Gate 5 — active safe witness-bundle contract.
 *
 * These tests exercise the production formatter used by the telemetry command,
 * rather than a test-only copy of its schema. They also prove that the bundle
 * is accepted by the real offline analyzer CLI and excludes unsafe fields.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceWitnessTracker, type WitnessTrackerConfig } from "../src/telemetry/diagnostics/deviceWitnessTracker";
import {
	buildSafeWitnessBundle,
	copyWitnessBundleToClipboard,
} from "../src/telemetry/diagnostics/witnessBundleFormat";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

const SENSITIVE_PATH = "Private Vault/medical-notes.md";
const SENSITIVE_CONTENT = "TOP_SECRET_WITNESS_FIXTURE";
const SENSITIVE_QA_SECRET = "qa-secret-SUPER_SECRET";
const SENSITIVE_TOKEN = "token_SUPER_SECRET";

function makeConfig(overrides: Partial<WitnessTrackerConfig> = {}): WitnessTrackerConfig {
	return {
		stateSecret: "state-secret-SUPER_SECRET",
		flightMode: "qa-safe",
		qaTraceSecret: SENSITIVE_QA_SECRET,
		platform: "desktop",
		sink: { record: () => {}, recordPath: async () => {} },
		traceContext: {
			traceId: "trace-bundle-test",
			bootId: "boot-001",
			deviceId: "device-bundle-001",
			vaultIdHash: "vault-hash",
			serverHostHash: "server-hash",
			pluginVersion: "1.6.1",
		},
		readCrdtContent: () => SENSITIVE_CONTENT,
		isCrdtTombstoned: () => false,
		getFileId: () => "file-bundle-001",
		readDiskContent: async () => SENSITIVE_CONTENT,
		sampleEditor: () => ({ kind: "not_open", content: null }),
		stableAfterMs: 20,
		getPathId: async () => "p:bundle-test",
		...overrides,
	};
}

async function makeTrackerWithSegment(): Promise<DeviceWitnessTracker> {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.markDirty(SENSITIVE_PATH, "local-edit");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(tracker.getCheckpointSegments().length > 0, "fixture emits checkpoint segment");
	return tracker;
}

function buildFromTracker(tracker: DeviceWitnessTracker) {
	return buildSafeWitnessBundle({
		pluginVersion: "1.6.1",
		deviceId: "device-bundle-001",
		localTraceId: "trace-bundle-test",
		platform: "desktop",
		runtimeState: tracker.getRuntimeState(),
		flightMode: tracker.getFlightMode(),
		qaTraceSecretHash: "sha256:fixture-hash",
		segments: tracker.getCheckpointSegments(),
		createdAt: "2026-08-09T00:00:00.000Z",
	});
}

test("production formatter emits the analyzer-compatible NDJSON header", async () => {
	const tracker = await makeTrackerWithSegment();
	const { bundle, eventCount, droppedUnsafeLineCount } = buildFromTracker(tracker);
	const lines = bundle.split("\n").filter(Boolean);
	const header = JSON.parse(lines[0]!) as Record<string, unknown>;

	assert.equal(header.kind, "bundle.header");
	assert.equal(header.bundleSchemaVersion, 1);
	assert.equal(header.privacyMode, "safe");
	assert.equal(header.containsRawPaths, false);
	assert.equal(header.deviceLabel, "(redacted)");
	assert.equal(header.eventCount, eventCount);
	assert.equal(header.droppedUnsafeLineCount, droppedUnsafeLineCount);
	for (const field of [
		"createdAt", "pluginVersion", "deviceId", "platform", "runtimeState",
		"localTraceId", "scenarioRunId", "scenarioId", "qaTraceSecretHash",
		"flightMode", "hashDomain",
	]) {
		assert.ok(field in header, `header includes ${field}`);
	}
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
	tracker.dispose();
});

test("safe formatter excludes raw paths, content, tokens, secrets, and unknown checkpoint fields", async () => {
	const tracker = await makeTrackerWithSegment();
	const trackerResult = buildFromTracker(tracker);
	const injectedResult = buildSafeWitnessBundle({
		pluginVersion: "1.6.1",
		deviceId: "device-bundle-001",
		localTraceId: "trace-bundle-test",
		platform: "desktop",
		runtimeState: "foreground",
		flightMode: "qa-safe",
		qaTraceSecretHash: "sha256:fixture-hash",
		segments: [{
			index: 99,
			content: `${JSON.stringify({ kind: "checkpoint.segment.header", traceId: "trace-bundle-test", deviceId: "device-bundle-001", segmentIndex: 99, firstSeq: 1 })}\n${JSON.stringify({
				kind: "device.witness.settled",
				seq: 1,
				path: SENSITIVE_PATH,
				fileId: "file-bundle-001",
				pathId: "p:bundle-test",
				data: {
					stateHash: "h:safe",
					scenarioStepLabel: SENSITIVE_PATH,
					noteContent: SENSITIVE_CONTENT,
					syncToken: SENSITIVE_TOKEN,
				},
			})}\n`,
		}],
		createdAt: "2026-08-09T00:00:00.000Z",
	});
	const serialized = `${trackerResult.bundle}${injectedResult.bundle}`;
	for (const sensitiveValue of [
		SENSITIVE_PATH,
		SENSITIVE_CONTENT,
		SENSITIVE_QA_SECRET,
		SENSITIVE_TOKEN,
		"state-secret-SUPER_SECRET",
	]) {
		assert.ok(!serialized.includes(sensitiveValue), `safe bundle excludes ${sensitiveValue}`);
	}
	assert.equal(injectedResult.droppedUnsafeLineCount, 0, "unknown fields are projected out, not treated as malformed records");
	assert.ok(injectedResult.bundle.includes('"stateHash":"h:safe"'), "allowlisted witness evidence remains");
	tracker.dispose();
});

test("production bundle is accepted by the real offline analyzer CLI", async () => {
	const tracker = await makeTrackerWithSegment();
	const { bundle } = buildFromTracker(tracker);
	const directory = mkdtempSync(join(tmpdir(), "yaos-witness-bundle-"));
	const bundlePath = join(directory, "bundle.ndjson");
	const reportPath = join(directory, "report.json");
	try {
		writeFileSync(bundlePath, bundle);
		execFileSync("bun", ["run", "qa/scripts/analyze-bundles.ts", "--", bundlePath, "--out", reportPath], {
			cwd: process.cwd(),
			stdio: "pipe",
		});
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as { summary: { ok: boolean; bundleCount: number } };
		assert.equal(report.summary.ok, true, "offline analyzer accepts production bundle");
		assert.equal(report.summary.bundleCount, 1, "offline analyzer accepts one production bundle");
	} finally {
		rmSync(directory, { recursive: true, force: true });
		tracker.dispose();
	}
});

test("clipboard delivery copies only the supplied safe bundle and fails closed", async () => {
	const copied: string[] = [];
	const bundle = "safe witness bundle";
	assert.equal(await copyWitnessBundleToClipboard(bundle, {
		writeText: async (value) => { copied.push(value); },
	}), true, "clipboard success is reported");
	assert.deepEqual(copied, [bundle], "clipboard receives the exact safe bundle");
	assert.equal(await copyWitnessBundleToClipboard(bundle, {
		writeText: async () => { throw new Error("denied"); },
	}), false, "clipboard failure requests UI fallback");
	assert.equal(await copyWitnessBundleToClipboard(bundle, null), false, "missing clipboard requests UI fallback");
});

test("active export command neither logs nor persists the raw bundle", async () => {
	const runtimeSource = readFileSync(join(process.cwd(), "src/telemetry/installTelemetryRuntime.ts"), "utf8");
	const start = runtimeSource.indexOf("async function exportSafeWitnessBundle");
	const end = runtimeSource.indexOf("function showDeviceIdentity", start);
	assert.ok(start >= 0 && end > start, "active export command source is located");
	const commandBody = runtimeSource.slice(start, end);
	for (const forbidden of ["console.", "vault.adapter", "vault.create", "vault.modify", "saveData(", "prompt("]) {
		assert.ok(!commandBody.includes(forbidden), `active export command excludes ${forbidden}`);
	}
	assert.ok(commandBody.includes("buildSafeWitnessBundle"), "active export uses the production formatter");
	assert.ok(commandBody.includes("copyWitnessBundleToClipboard"), "active export uses clipboard delivery");
	assert.ok(commandBody.includes("WitnessBundleExportModal"), "active export has a selectable fallback modal");
});

for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (error) {
		console.error(`  FAIL  ${name}`);
		console.error(`    ${error instanceof Error ? error.message : String(error)}`);
		failed++;
	}
}

console.log(`\nGate 5 (active witness bundle export): ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
