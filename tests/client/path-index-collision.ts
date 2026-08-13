import * as Y from "yjs";
import { normalizePath } from "obsidian";
import { VaultSync } from "../../src/sync/vaultSync";
import { createNestedActiveMeta, type MetaSemanticChange } from "../../src/sync/fileMeta";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

function makeVaultSyncFixture(): VaultSync {
	const vaultSync = Object.create(VaultSync.prototype) as VaultSync & Record<string, unknown>;
	vaultSync.ydoc = new Y.Doc();
	vaultSync.pathToId = vaultSync.ydoc.getMap("pathToId");
	vaultSync.idToText = vaultSync.ydoc.getMap("idToText");
	vaultSync.meta = vaultSync.ydoc.getMap("meta");
	vaultSync.sys = vaultSync.ydoc.getMap("sys");
	vaultSync.pathToBlob = vaultSync.ydoc.getMap("pathToBlob");
	vaultSync.blobMeta = vaultSync.ydoc.getMap("blobMeta");
	vaultSync.blobTombstones = vaultSync.ydoc.getMap("blobTombstones");
	vaultSync.provider = {};
	vaultSync._pathIndex = new Map<string, string>();
	vaultSync._deletedPathIndex = new Set<string>();
	vaultSync._pathIndexesDirty = true;
	vaultSync._metaSnapshot = new Map();
	vaultSync._metaSemanticListeners = new Set();
	vaultSync._metaObserverFallbackCount = 0;
	vaultSync._textToFileId = new WeakMap();
	vaultSync._eventRing = [];
	vaultSync.debug = false;
	vaultSync.sys.set("schemaVersion", 3);
	return vaultSync as VaultSync;
}

console.log("\n--- Path-index collision invalidation ---");

{
	const vaultSync = makeVaultSyncFixture();
	const path = "notes/collision.md";
	vaultSync.ydoc.transact(() => {
		vaultSync.meta.set("id-a", createNestedActiveMeta(path, 100, "device-a"));
		vaultSync.meta.set("id-b", createNestedActiveMeta(path, 200, "device-b"));
	});

	const invalidate = (vaultSync as unknown as {
		invalidatePathIndexesForMetaChanges: (changes: readonly MetaSemanticChange[]) => void;
	}).invalidatePathIndexesForMetaChanges.bind(vaultSync);

	assert(vaultSync.getFileId(path) === "id-b", "higher initial mtime wins the collision");
	assert(
		(vaultSync as unknown as { _pathIndexesDirty: boolean })._pathIndexesDirty === false,
		"initial lookup leaves the lazy index clean",
	);

	vaultSync.ydoc.transact(() => {
		(vaultSync.meta.get("id-a") as Y.Map<unknown>).set("mtime", 300);
	});
	invalidate([{ kind: "mtime-changed", fileId: "id-a", path }]);

	assert(
		(vaultSync as unknown as { _pathIndexesDirty: boolean })._pathIndexesDirty === true,
		"mtime-only change dirties an index whose winner depends on mtime",
	);
	assert(vaultSync.getFileId(path) === "id-a", "next lazy lookup recomputes the new mtime winner");

	vaultSync.ydoc.transact(() => {
		(vaultSync.meta.get("id-a") as Y.Map<unknown>).set("device", "device-a2");
	});
	invalidate([{ kind: "device-changed", fileId: "id-a", path }]);

	assert(
		(vaultSync as unknown as { _pathIndexesDirty: boolean })._pathIndexesDirty === false,
		"device-only change does not dirty the path index",
	);
	assert(vaultSync.getFileId(normalizePath(path)) === "id-a", "device-only change preserves the current winner");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
