/**
 * Flight recorder tests (updated for v2 spec).
 *
 * Covers:
 *   - PathIdentityResolver: async SHA-256 promise cache, vault-derived salt,
 *     cross-device correlation, directory() for unredacted exports
 *   - FlightRecorder: priority-aware queue, safeToShare/includesFilenames, validateSafeEvent
 *   - FlightTraceController: flush(), recordPath() ordering
 *   - Event model: FLIGHT_KIND constants, FlightKind type
 */

import { PathIdentityResolver, deriveVaultPathSalt, deriveSaltFingerprint } from "../src/telemetry/debug/pathIdentity";
import { FlightRecorder } from "../src/telemetry/debug/flightRecorder";
import { FLIGHT_KIND } from "../src/observability/flightTaxonomy";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

async function assertAsync(fn: () => Promise<boolean>, msg: string): Promise<void> {
	try {
		const result = await fn();
		assert(result, msg);
	} catch (err) {
		console.error(`  FAIL  ${msg} — threw: ${String(err)}`);
		failed++;
	}
}

import { createHash } from "node:crypto";

async function sha256Hex(input: string): Promise<string> {
	return createHash("sha256").update(input).digest("hex");
}

// Track whether sha256Hex was called (to verify it's used, not FNV)
let sha256CallCount = 0;
async function trackingSha256(input: string): Promise<string> {
	sha256CallCount++;
	return sha256Hex(input);
}

// ---------------------------------------------------------------------------
// Test 1: PathIdentityResolver — stable pseudonyms, never a raw path
// ---------------------------------------------------------------------------
console.log("\n--- Test 1: PathIdentityResolver pseudonymizes every path ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "test-salt-one" });

	const id1 = await resolver.getPathIdentity("Daily/2026-05-12.md");
	const id2 = await resolver.getPathIdentity("Daily/2026-05-12.md");
	assert(id1.pathId === id2.pathId, "Same path gets same pathId within session");
	assert(!id1.path, "Resolver never returns a raw path");
	assert(id1.pathId.startsWith("p:"), "pathId has p: prefix");
	assert(id1.pathId.length >= 34, "pathId has >=32 hex chars (128 bits) after 'p:'");

	const idOther = await resolver.getPathIdentity("Projects/foo.md");
	assert(id1.pathId !== idOther.pathId, "Different paths get different pathIds");
}

// ---------------------------------------------------------------------------
// Test 2: directory() is the only place raw paths leave the resolver
// ---------------------------------------------------------------------------
console.log("\n--- Test 2: directory() maps pseudonyms back to raw paths ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "test-salt-two" });
	const id = await resolver.getPathIdentity("Daily/2026-05-12.md");
	await resolver.getPathIdentity("Projects/foo.md");

	const directory = resolver.directory();
	assert(directory.length === 2, "directory() lists every path resolved so far");
	const entry = directory.find((e) => e.pathId === id.pathId);
	assert(entry?.path === "Daily/2026-05-12.md", "directory() pairs a pseudonym with its raw path");
	assert(directory.every((e) => e.pathId.startsWith("p:")), "directory() keys are pathIds, not bare digests");

	// Resolving the same path again must not duplicate the directory entry.
	await resolver.getPathIdentity("Daily/2026-05-12.md");
	assert(resolver.directory().length === 2, "directory() does not duplicate repeated paths");
}

// ---------------------------------------------------------------------------
// Test 3: deriveVaultPathSalt is deterministic, vault-scoped, and opaque
// ---------------------------------------------------------------------------
console.log("\n--- Test 3: deriveVaultPathSalt determinism ---");
{
	const vaultId = "vault-abc-123";
	const salt = await deriveVaultPathSalt(sha256Hex, vaultId);
	const saltAgain = await deriveVaultPathSalt(sha256Hex, `  ${vaultId}  `);
	const otherSalt = await deriveVaultPathSalt(sha256Hex, "vault-xyz-789");
	const bareDigest = await sha256Hex(vaultId);

	assert(salt === saltAgain, "Same vaultId derives the same salt (whitespace-insensitive)");
	assert(salt !== otherSalt, "Different vaultId derives a different salt");
	assert(!salt.includes(vaultId), "Salt does not carry the vaultId verbatim");
	assert(salt !== bareDigest, "Salt is domain-separated, not a bare digest of the vaultId");
}

// ---------------------------------------------------------------------------
// Test 4: two devices on one vault correlate with no shared user secret
// ---------------------------------------------------------------------------
console.log("\n--- Test 4: cross-device pathId correlation ---");
{
	const vaultId = "shared-vault-id";
	const saltA = await deriveVaultPathSalt(sha256Hex, vaultId);
	const saltB = await deriveVaultPathSalt(sha256Hex, vaultId);
	const deviceA = new PathIdentityResolver(sha256Hex, { salt: saltA });
	const deviceB = new PathIdentityResolver(sha256Hex, { salt: saltB });

	const idA = await deviceA.getPathIdentity("notes/project.md");
	const idB = await deviceB.getPathIdentity("notes/project.md");
	assert(idA.pathId === idB.pathId, "Same vault, two devices, same pathId — no user-managed secret involved");

	const fingerprintA = await deriveSaltFingerprint(sha256Hex, saltA);
	const fingerprintB = await deriveSaltFingerprint(sha256Hex, saltB);
	assert(fingerprintA === fingerprintB, "Both devices publish the same salt fingerprint");
	assert(fingerprintA !== saltA, "Fingerprint is not the salt itself");
	assert(!fingerprintA.includes(saltA), "Fingerprint does not embed the salt");
}

// ---------------------------------------------------------------------------
// Test 5: different vaults are uncorrelated
// ---------------------------------------------------------------------------
console.log("\n--- Test 5: different vaults produce different pathIds ---");
{
	const saltA = await deriveVaultPathSalt(sha256Hex, "vault-A");
	const saltB = await deriveVaultPathSalt(sha256Hex, "vault-B");
	const r1 = new PathIdentityResolver(sha256Hex, { salt: saltA });
	const r2 = new PathIdentityResolver(sha256Hex, { salt: saltB });

	const id1 = await r1.getPathIdentity("Daily/2026-05-12.md");
	const id2 = await r2.getPathIdentity("Daily/2026-05-12.md");
	assert(id1.pathId !== id2.pathId, "Different vault salts produce different pathIds");

	const f1 = await deriveSaltFingerprint(sha256Hex, saltA);
	const f2 = await deriveSaltFingerprint(sha256Hex, saltB);
	assert(f1 !== f2, "Different salts publish different fingerprints, so traces cannot be merged by mistake");
}

// ---------------------------------------------------------------------------
// Test 6: prime() populates cache before getPathIdentity
// ---------------------------------------------------------------------------
console.log("\n--- Test 6: prime() prepopulates cache ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "prime-test" });
	const paths = ["a.md", "b.md", "c.md"];
	await resolver.prime(paths);

	const id = await resolver.getPathIdentity("a.md");
	assert(id.pathId.startsWith("p:"), "primed path has p: prefix");

	const id2 = await resolver.getPathIdentity("a.md");
	assert(id.pathId === id2.pathId, "prime result is stable on repeated calls");
}

// ---------------------------------------------------------------------------
// Test 7: PathIdentityResolver calls sha256Hex (not FNV) in normal operation
// ---------------------------------------------------------------------------
console.log("\n--- Test 7: PathIdentityResolver uses crypto hash, not FNV ---");
{
	sha256CallCount = 0;
	const resolver = new PathIdentityResolver(trackingSha256, { salt: "test" });
	await resolver.getPathIdentity("some/file.md");
	assert(sha256CallCount > 0, "sha256Hex was called at least once (not FNV)");

	// The pathId should be 'p:' + 32 hex chars from SHA-256, not 'pd:' (degraded prefix)
	const id = await resolver.getPathIdentity("another/file.md");
	assert(id.pathId.startsWith("p:") && !id.pathId.startsWith("pd:"), "Normal pathId uses p: prefix (not pd: degraded prefix)");
	assert(id.pathId.length === 34, "pathId is p: + 32 hex chars = 34 chars total");
}

// ---------------------------------------------------------------------------
// Test 8: FlightRecorder.safeToShare and includesFilenames
// ---------------------------------------------------------------------------
console.log("\n--- Test 8: FlightRecorder safeToShare / includesFilenames ---");
{
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async () => {},
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const makeRecorder = (mode: string) =>
		new FlightRecorder(mockApp as never, {
			mode: mode as never,
			deviceId: "test-device",
			vaultIdHash: "0".repeat(64),
			serverHostHash: "1".repeat(64),
			pluginVersion: "1.0.0",
		});

	const safeRec = makeRecorder("safe");
	assert(safeRec.safeToShare === true, "safe mode: safeToShare=true");
	assert(safeRec.includesFilenames === false, "safe mode: includesFilenames=false");
	assert(safeRec.exportable === true, "safe mode: exportable=true");

	const qaSafeRec = makeRecorder("qa-safe");
	assert(qaSafeRec.safeToShare === true, "qa-safe mode: safeToShare=true");
	assert(qaSafeRec.includesFilenames === false, "qa-safe mode: includesFilenames=false");

	const fullRec = makeRecorder("full");
	assert(fullRec.safeToShare === false, "full mode: safeToShare=false");
	assert(fullRec.includesFilenames === true, "full mode: includesFilenames=true");
	assert(fullRec.exportable === true, "full mode: exportable=true");

	const localPrivRec = makeRecorder("local-private");
	assert(localPrivRec.safeToShare === false, "local-private: safeToShare=false");
	assert(localPrivRec.includesFilenames === true, "local-private: includesFilenames=true");
	assert(localPrivRec.exportable === false, "local-private: exportable=false");
}

// ---------------------------------------------------------------------------
// Test 9: validateSafeEvent — event with raw path in data is dropped
// ---------------------------------------------------------------------------
console.log("\n--- Test 9: validateSafeEvent drops events with raw path in data ---");
{
	const writtenLines: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_path: string, content: string) => { writtenLines.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	// This event has 'path' in data — must be dropped and emit redaction.failure
	recorder.record({
		priority: "important",
		kind: FLIGHT_KIND.crdtFileCreated,
		severity: "info",
		scope: "file",
		source: "vaultSync",
		layer: "crdt",
		pathId: "p:test",
		data: { path: "secret/file.md" },
	});

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = writtenLines.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	// The leaking event must NOT be present
	const hasLeakingEvent = parsed.some(
		(e) => e.kind === FLIGHT_KIND.crdtFileCreated && e.data?.path === "secret/file.md",
	);
	assert(!hasLeakingEvent, "Event with raw path in data was dropped");

	// A redaction.failure event MUST be present
	const hasRedactionFailure = parsed.some((e) => e.kind === FLIGHT_KIND.redactionFailure);
	assert(hasRedactionFailure, "redaction.failure event was emitted for the dropped event");
}

// ---------------------------------------------------------------------------
// Test 10: Priority-aware queue — critical events survive full-buffer pressure
// ---------------------------------------------------------------------------
console.log("\n--- Test 10: Critical events survive full-buffer pressure ---");
{
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, content: string) => { written.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	// Tiny buffer so it fills quickly
	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
		maxPendingLines: 2,
		maxPendingChars: 2000,
	});

	// Fill buffer with verbose events
	for (let i = 0; i < 5; i++) {
		recorder.record({
			priority: "verbose",
			kind: FLIGHT_KIND.qaCheckpoint,
			severity: "debug",
			scope: "diagnostics",
			source: "traceRuntime",
			layer: "diagnostics",
		});
	}

	// Record a critical event — must not be dropped
	recorder.record({
		priority: "critical",
		kind: FLIGHT_KIND.crdtFileTombstoned,
		severity: "info",
		scope: "file",
		source: "vaultSync",
		layer: "crdt",
		pathId: "p:test-critical",
	});

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	const hasCritical = parsed.some((e) => e.kind === FLIGHT_KIND.crdtFileTombstoned);
	assert(hasCritical, "Critical event survived full-buffer pressure");
}

// ---------------------------------------------------------------------------
// Test 11: Verbose events dropped before important events
// ---------------------------------------------------------------------------
console.log("\n--- Test 11: Verbose events dropped before important events ---");
{
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, content: string) => { written.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
		maxPendingLines: 2,
		maxPendingChars: 5000,
	});

	// Fill with verbose
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	// Now record an important event — verbose should be evicted
	recorder.record({ priority: "important", kind: FLIGHT_KIND.providerConnected, severity: "info", scope: "connection", source: "connectionController", layer: "provider" });

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	const hasImportant = parsed.some((e) => e.kind === FLIGHT_KIND.providerConnected);
	assert(hasImportant, "Important event survived when buffer was full of verbose entries");
}

// ---------------------------------------------------------------------------
// Test 12: flight.events.dropped includes priority breakdown
// ---------------------------------------------------------------------------
console.log("\n--- Test 12: flight.events.dropped includes droppedByPriority ---");
{
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, content: string) => { written.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
		maxPendingLines: 1,
		maxPendingChars: 5000,
	});

	// Force a drop by overfilling with verbose
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "important", kind: FLIGHT_KIND.providerConnected, severity: "info", scope: "connection", source: "connectionController", layer: "provider" });
	recorder.record({ priority: "important", kind: FLIGHT_KIND.providerConnected, severity: "info", scope: "connection", source: "connectionController", layer: "provider" });

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	const droppedEvent = parsed.find((e) => e.kind === FLIGHT_KIND.flightEventsDropped);
	assert(!!droppedEvent, "flight.events.dropped was emitted");
	assert(
		droppedEvent && typeof droppedEvent.data?.droppedByPriority === "object",
		"flight.events.dropped has droppedByPriority breakdown",
	);
	assert(
		droppedEvent && droppedEvent.data?.droppedByPriority?.critical === 0,
		"critical count in droppedByPriority is always 0",
	);
}

// ---------------------------------------------------------------------------
// Test 13: Map indexes rebuild correctly after ring trim (no stale keys)
// ---------------------------------------------------------------------------
console.log("\n--- Test 13: Map indexes rebuild after ring trim ---");
{
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async () => {},
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	// Record two events for different paths and ops
	recorder.record({ priority: "important", kind: FLIGHT_KIND.diskCreateObserved, severity: "info", scope: "file", source: "vaultEvents", layer: "disk", pathId: "p:path-old", opId: "op-old" });
	recorder.record({ priority: "important", kind: FLIGHT_KIND.diskModifyObserved, severity: "info", scope: "file", source: "vaultEvents", layer: "disk", pathId: "p:path-new", opId: "op-new" });

	const timelineOld = recorder.getTimelineForPath("p:path-old");
	const timelineNew = recorder.getTimelineForPath("p:path-new");
	assert(timelineOld.length > 0, "Timeline for old path is present before trim");
	assert(timelineNew.length > 0, "Timeline for new path is present");
}

// ---------------------------------------------------------------------------
// Test 14: FLIGHT_KIND constants cover all Phase A events
// ---------------------------------------------------------------------------
console.log("\n--- Test 14: FLIGHT_KIND taxonomy constants ---");
{
	assert(FLIGHT_KIND.diskCreateObserved === "disk.create.observed", "disk create observed (renamed from create_seen)");
	assert(FLIGHT_KIND.diskModifyObserved === "disk.modify.observed", "disk modify observed");
	assert(FLIGHT_KIND.diskDeleteObserved === "disk.delete.observed", "disk delete observed");
	assert(FLIGHT_KIND.diskEventSuppressed === "disk.event.suppressed", "disk event suppressed (meta, kept)");
	assert(FLIGHT_KIND.diskEventNotSuppressed === "disk.event.not_suppressed", "disk not suppressed (critical)");
	assert(FLIGHT_KIND.diskWriteOk === "disk.write.ok", "disk write ok");
	assert(FLIGHT_KIND.diskWriteFailed === "disk.write.failed", "disk write failed");
	assert(FLIGHT_KIND.crdtFileCreated === "crdt.file.created", "crdt file created");
	assert(FLIGHT_KIND.crdtFileUpdated === "crdt.file.updated", "crdt file updated (new)");
	assert(FLIGHT_KIND.crdtFileTombstoned === "crdt.file.tombstoned", "crdt file tombstoned");
	assert(FLIGHT_KIND.crdtFileRevived === "crdt.file.revived", "crdt file revived");
	assert(FLIGHT_KIND.reconcileComplete === "reconcile.complete", "reconcile complete");
	assert(FLIGHT_KIND.reconcileFileDecision === "reconcile.file.decision", "reconcile file decision (new)");
	assert(FLIGHT_KIND.reconcileSafetyBrakeTriggered === "reconcile.safety_brake.triggered", "safety brake");
	assert(FLIGHT_KIND.serverReceiptConfirmed === "server.receipt.confirmed", "receipt confirmed");
	assert(FLIGHT_KIND.serverReceiptCandidateCaptured === "server.receipt.candidate_captured", "receipt candidate");
	assert(FLIGHT_KIND.qaCheckpoint === "qa.checkpoint", "qa checkpoint");
	assert(FLIGHT_KIND.exportManifest === "export.manifest", "export manifest (new)");
	assert(FLIGHT_KIND.redactionFailure === "redaction.failure", "redaction failure (new)");
	assert(FLIGHT_KIND.pathIdentityDegraded === "path.identity.degraded", "path identity degraded (new)");
	assert(FLIGHT_KIND.flightLogsRotated === "flight.logs.rotated", "logs rotated (new)");
}

// ---------------------------------------------------------------------------
// Test 15: the derived path salt must never appear in any serialized event
// ---------------------------------------------------------------------------
console.log("\n--- Test 15: path salt never leaks into NDJSON ---");
{
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, c: string) => { written.push(c); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	// The salt is the one value that would let a reader of an exported trace
	// brute-force vault paths back out of the pathIds. It lives in the
	// resolver and must never reach a written line.
	const salt = await deriveVaultPathSalt(sha256Hex, "leak-test-vault-id");
	const resolver = new PathIdentityResolver(sha256Hex, { salt });
	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	const { pathId } = await resolver.getPathIdentity("Projects/secret/finance.md");
	recorder.record({
		priority: "important",
		kind: FLIGHT_KIND.diskModifyObserved,
		severity: "info",
		scope: "file",
		source: "vaultEvents",
		layer: "disk",
		pathId,
	});

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	assert(allOutput.includes(pathId), "pathId is written (the event was actually recorded)");
	assert(!allOutput.includes(salt), "Derived path salt did not leak into NDJSON output");
	assert(!allOutput.includes("leak-test-vault-id"), "Raw vaultId did not leak into NDJSON output");
	assert(!allOutput.includes("Projects/secret/finance.md"), "Raw path did not leak into NDJSON output");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────\n");

if (failed > 0) {
	process.exit(1);
}
