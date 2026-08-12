import * as Y from "yjs";
import { VaultSync } from "../src/sync/vaultSync";
import { ORIGIN_SEED } from "../src/sync/origins";

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
	vaultSync.provider = { remote: true };
	vaultSync._textToFileId = new WeakMap();
	vaultSync._eventRing = [];
	vaultSync.debug = false;
	return vaultSync as VaultSync;
}

console.log("\n--- Telemetry content witness subscription ---");

{
	const vaultSync = makeVaultSyncFixture();
	const remoteOrigin = (vaultSync as unknown as { provider: object }).provider;
	const firstText = new Y.Text();

	vaultSync.ydoc.transact(() => {
		vaultSync.meta.set("id-a", { path: "notes/a.md", mtime: 1 });
		vaultSync.idToText.set("id-a", firstText);
	}, ORIGIN_SEED);

	const events: Array<{ path: string; isLocal: boolean }> = [];
	const unsubscribe = vaultSync.observePathContentChanges((path, isLocal) => {
		events.push({ path, isLocal });
	});

	vaultSync.ydoc.transact(() => {
		firstText.insert(0, "local edit");
	}, ORIGIN_SEED);
	assert(events.length === 1 && events[0]?.path === "notes/a.md" && events[0]?.isLocal === true,
		"existing Y.Text emits its active path as a local edit");

	vaultSync.ydoc.transact(() => {
		firstText.insert(firstText.length, " remote edit");
	}, remoteOrigin);
	assert(events.length === 2 && events[1]?.path === "notes/a.md" && events[1]?.isLocal === false,
		"provider-origin Y.Text edit is reported as remote");

	const secondText = new Y.Text();
	vaultSync.ydoc.transact(() => {
		vaultSync.meta.set("id-b", { path: "notes/b.md", mtime: 1 });
		vaultSync.idToText.set("id-b", secondText);
	}, ORIGIN_SEED);
	vaultSync.ydoc.transact(() => {
		secondText.insert(0, "later text");
	}, remoteOrigin);
	assert(events.length === 3 && events[2]?.path === "notes/b.md" && events[2]?.isLocal === false,
		"Y.Text added after subscription is observed with its own path");

	unsubscribe();
	unsubscribe();
	vaultSync.ydoc.transact(() => {
		firstText.insert(firstText.length, " ignored");
		secondText.insert(secondText.length, " ignored");
	}, remoteOrigin);
	assert(events.length === 3, "unsubscribe detaches every Y.Text observer and is idempotent");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
