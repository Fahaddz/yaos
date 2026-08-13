/**
 * Pure unit tests for closedFilePlanner.
 *
 * Tests the same function that ReconciliationController will call during
 * authoritative reconciliation. No Obsidian, no Yjs, no disk I/O.
 */

import { planClosedFileReconcile } from "../../src/runtime/reconcile/closedFilePlanner";
import type { ClosedFileReconcileInput } from "../../src/runtime/reconcile/closedFilePlanner";

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

// Helper: SHA-256 hex-like strings (just need to be distinct for testing)
const HASH_A = "aaaa";
const HASH_B = "bbbb";
const HASH_C = "cccc";

function makeInput(overrides: Partial<ClosedFileReconcileInput> = {}): ClosedFileReconcileInput {
	return {
		path: "notes/test.md",
		mode: "authoritative",
		isOpenOrBound: false,
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_C,
		...overrides,
	};
}

// -----------------------------------------------------------------------
// Non-authoritative mode
// -----------------------------------------------------------------------

console.log("\n--- Test 1: non-authoritative mode => defer-to-crdt-flush ---");
{
	const action = planClosedFileReconcile(makeInput({ mode: "conservative" }));
	assert(action.kind === "defer-to-crdt-flush", "kind is defer-to-crdt-flush");
	assert(action.reason === "non-authoritative-mode", "reason is non-authoritative-mode");
}

// -----------------------------------------------------------------------
// Open/bound files
// -----------------------------------------------------------------------

console.log("\n--- Test 2: open or bound file => defer-to-crdt-flush ---");
{
	const action = planClosedFileReconcile(makeInput({ isOpenOrBound: true }));
	assert(action.kind === "defer-to-crdt-flush", "kind is defer-to-crdt-flush");
	assert(action.reason === "open-or-bound", "reason is open-or-bound");
}

// -----------------------------------------------------------------------
// Disk equals CRDT
// -----------------------------------------------------------------------

console.log("\n--- Test 3: disk == CRDT => no-op ---");
{
	const action = planClosedFileReconcile(makeInput({ diskHash: HASH_A, crdtHash: HASH_A }));
	assert(action.kind === "no-op", "kind is no-op");
	assert(action.reason === "disk-equals-crdt", "reason is disk-equals-crdt");
}

// -----------------------------------------------------------------------
// Three-way: disk at baseline, CRDT changed
// -----------------------------------------------------------------------

console.log("\n--- Test 4: disk at baseline, CRDT changed => apply-remote-to-disk ---");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_A, // disk == baseline, CRDT changed
	}));
	assert(action.kind === "apply-remote-to-disk", "CRDT wins cleanly");
	assert(action.reason === "disk-at-baseline", "reason is disk-at-baseline");
}

// -----------------------------------------------------------------------
// Three-way: CRDT at baseline, disk changed
// -----------------------------------------------------------------------

console.log("\n--- Test 5: CRDT at baseline, disk changed => import-disk-to-crdt ---");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_B,
		crdtHash: HASH_A,
		baselineHash: HASH_A, // CRDT == baseline, disk changed
	}));
	assert(action.kind === "import-disk-to-crdt", "disk wins cleanly");
	assert(action.reason === "crdt-at-baseline", "reason is crdt-at-baseline");
}

// -----------------------------------------------------------------------
// Three-way: both changed
// -----------------------------------------------------------------------

console.log("\n--- Test 6: both changed => create-conflict-artifact ---");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_C, // neither matches baseline
	}));
	assert(action.kind === "create-conflict-artifact", "conflict artifact created");
	assert(action.kind === "create-conflict-artifact" && action.winner === "disk", "disk wins");
	assert(action.kind === "create-conflict-artifact" && action.preserveSide === "crdt", "CRDT preserved as artifact");
	assert(action.reason === "both-changed", "reason is both-changed");
}

// -----------------------------------------------------------------------
// Missing baseline: disk newer than last save
// -----------------------------------------------------------------------

console.log("\n--- Test 7: missing baseline, disk newer => conflict, disk wins ---");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: null,
		diskMtime: 2000,
		lastDiskIndexPersistedAt: 1000, // disk modified after last save
	}));
	assert(action.kind === "create-conflict-artifact", "conflict created");
	assert(action.kind === "create-conflict-artifact" && action.winner === "disk", "disk wins (newer)");
	assert(action.kind === "create-conflict-artifact" && action.preserveSide === "crdt", "CRDT preserved");
	assert(action.kind === "create-conflict-artifact" && action.missingBaselinePolicy === "disk-mtime-after-last-index-save", "policy documented");
}

// -----------------------------------------------------------------------
// Missing baseline: no mtime evidence
// -----------------------------------------------------------------------

console.log("\n--- Test 8: missing baseline, no mtime evidence => conflict, CRDT wins ---");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: null,
		// no diskMtime, no lastDiskIndexPersistedAt
	}));
	assert(action.kind === "create-conflict-artifact", "conflict created");
	assert(action.kind === "create-conflict-artifact" && action.winner === "crdt", "CRDT wins (safe default)");
	assert(action.kind === "create-conflict-artifact" && action.preserveSide === "disk", "disk preserved");
	assert(action.kind === "create-conflict-artifact" && action.missingBaselinePolicy === "crdt-default-no-evidence", "policy documented");
}

// -----------------------------------------------------------------------
// Missing baseline: mtime present but disk not newer
// -----------------------------------------------------------------------

console.log("\n--- Test 9: missing baseline, disk NOT newer => conflict, CRDT wins ---");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: null,
		diskMtime: 500,
		lastDiskIndexPersistedAt: 1000, // disk older than last save
	}));
	assert(action.kind === "create-conflict-artifact", "conflict created");
	assert(action.kind === "create-conflict-artifact" && action.winner === "crdt", "CRDT wins");
	assert(action.kind === "create-conflict-artifact" && action.missingBaselinePolicy === "crdt-default-disk-not-newer", "policy: not newer");
}

// -----------------------------------------------------------------------
// Path is preserved in all actions
// -----------------------------------------------------------------------

console.log("\n--- Test 10: path is preserved in all action kinds ---");
{
	const path = "deep/nested/path/file.md";
	const action1 = planClosedFileReconcile(makeInput({ path, diskHash: HASH_A, crdtHash: HASH_A }));
	assert(action1.path === path, "path preserved in no-op");

	const action2 = planClosedFileReconcile(makeInput({ path, mode: "conservative" }));
	assert(action2.path === path, "path preserved in defer");

	const action3 = planClosedFileReconcile(makeInput({ path, diskHash: HASH_A, crdtHash: HASH_B, baselineHash: HASH_A }));
	assert(action3.path === path, "path preserved in apply-remote");
}

// -----------------------------------------------------------------------
// Edge: disk == crdt even when baseline is null
// -----------------------------------------------------------------------

console.log("\n--- Test 11: disk == CRDT with null baseline => no-op (not conflict) ---");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_A,
		baselineHash: null,
	}));
	assert(action.kind === "no-op", "agreement overrides missing baseline");
}

// -----------------------------------------------------------------------
// Characterization: open/bound file semantics (IMPORTANT — read before changing)
//
// When isOpenOrBound=true in authoritative mode, the planner returns
// defer-to-crdt-flush. The ReconciliationController pre-filters open/bound
// paths before calling the planner (the outer `!isOpenOrBound` guard in
// the updatedOnDisk loop), which means this return value is currently
// unreachable from the controller path.
//
// The semantics are intentional: open/bound files are NOT flushed to disk
// during reconcile. Convergence is guaranteed by other paths:
//
//   externalEditPolicy="always":
//     vault.modify fires for the external disk change →
//     syncFileFromDisk called → decideExternalEditImport returns allowImport:true →
//     handleBoundFileSyncGap resolves disk↔CRDT via the live editor binding.
//
//   externalEditPolicy="closed-only":
//     vault.modify fires but syncFileFromDisk defers (open file, closed-only policy) →
//     on tab close: reconcileTrackedOpenFiles → maybeImportDeferredClosedOnlyPath →
//     processDirtyMarkdownPath → syncFileFromDisk with file now closed → import runs.
//
//   Stale binding (isBound but no MarkdownView):
//     next syncFileFromDisk call hits the stale-binding cleaner at
//     reconciliationController.ts:1356-1363 → unbindByPath → proceeds normally.
//     Workspace-restore case: y-codemirror initializes editor from CRDT →
//     diskMirror writes to disk.
//
// The OLD pre-extraction behavior (flushing CRDT to disk during reconcile
// for open files) was a latent bug: it raced with vault.modify →
// syncFileFromDisk → handleBoundFileSyncGap, potentially overwriting a
// correct disk→CRDT merge with a stale CRDT→disk flush.
//
// DO NOT restore the flush without understanding these convergence paths.
// -----------------------------------------------------------------------

console.log("\n--- Test 12 (characterization): open file in authoritative mode defers ---");
{
	// Current contract: isOpenOrBound=true → defer-to-crdt-flush.
	// This is reached when conservative mode runs (mode is "conservative"),
	// or when the controller explicitly passes isOpenOrBound=true.
	// See convergence analysis above for why this is correct.
	const action = planClosedFileReconcile(makeInput({
		mode: "authoritative",
		isOpenOrBound: true,
		diskHash: HASH_A,
		crdtHash: HASH_B, // disk differs from CRDT
		baselineHash: HASH_A,
	}));
	assert(action.kind === "defer-to-crdt-flush", "open file → defer (convergence via vault.modify path)");
	assert(action.reason === "open-or-bound", "reason documents why flush was deferred");
}

console.log("\n--- Test 13 (characterization): conservative mode always defers ---");
{
	// In conservative mode the planner defers all updatedOnDisk paths.
	// Note: vaultSync.reconcileVault only populates updatedOnDisk in
	// authoritative mode, so this path is currently unreachable from
	// runReconciliation. The planner handles it correctly if called.
	const actionDiffers = planClosedFileReconcile(makeInput({
		mode: "conservative",
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_A,
	}));
	assert(actionDiffers.kind === "defer-to-crdt-flush", "conservative → defer regardless of hash state");

	const actionAgrees = planClosedFileReconcile(makeInput({
		mode: "conservative",
		diskHash: HASH_A,
		crdtHash: HASH_A,
	}));
	assert(actionAgrees.kind === "defer-to-crdt-flush", "conservative → defer even when disk==crdt");
}

console.log("\n--- Test 14 (characterization): closed/unbound file in authoritative mode does NOT defer ---");
{
	// The symmetric guarantee: once isOpenOrBound=false and mode=authoritative,
	// the planner uses the full three-way conflict resolution. This is the path
	// the controller exercises for every file in updatedOnDisk that is not open.
	const actionApplyRemote = planClosedFileReconcile(makeInput({
		mode: "authoritative",
		isOpenOrBound: false,
		diskHash: HASH_A,     // disk at baseline
		crdtHash: HASH_B,     // CRDT moved
		baselineHash: HASH_A,
	}));
	assert(actionApplyRemote.kind === "apply-remote-to-disk", "closed + CRDT-only-change → apply remote");

	const actionImportDisk = planClosedFileReconcile(makeInput({
		mode: "authoritative",
		isOpenOrBound: false,
		diskHash: HASH_B,     // disk moved
		crdtHash: HASH_A,     // CRDT at baseline
		baselineHash: HASH_A,
	}));
	assert(actionImportDisk.kind === "import-disk-to-crdt", "closed + disk-only-change → import disk");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
