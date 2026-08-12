/**
 * Tests for the invariant document re-materialisation rests on.
 *
 * rematerializeDocument() replaces the live Y.Doc with a fresh one decoded from
 * the current document's own encoded state, to discard the V8 rope structures a
 * long warm session accumulates.  It is safe only because that round trip is
 * exact: clients keep syncing against the replacement without noticing, so any
 * divergence would be silent corruption of the live document.
 *
 * These cover the shapes a real vault contains — nested Y.Map metadata, deleted
 * items, GC structs from reaped bodies, multiple client ids — plus the
 * coordinator retarget, which is the part that would otherwise leave the dirty
 * listener attached to a discarded document and stop persisting entirely.
 */

import * as Y from "yjs";
import { PersistenceCoordinator, type DocStore, type DocStoreJournalStats } from "../server/src/persistenceCoordinator";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);
		passed++;
	} else {
		console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
		failed++;
	}
}

class MemoryDocStore implements DocStore {
	snapshot: Uint8Array | null = null;
	journal: Uint8Array[] = [];
	appendUpdate(update: Uint8Array): DocStoreJournalStats {
		this.journal.push(update.slice());
		return this.getJournalStats();
	}
	rewriteCheckpoint(update: Uint8Array): void {
		this.snapshot = update.slice();
		this.journal = [];
	}
	getJournalStats(): DocStoreJournalStats {
		return {
			entryCount: this.journal.length,
			totalBytes: this.journal.reduce((sum, e) => sum + e.byteLength, 0),
		};
	}
}

/** The operation under test, isolated from the Durable Object. */
function rematerialize(doc: Y.Doc): Y.Doc {
	const fresh = new Y.Doc();
	Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
	return fresh;
}

function census(doc: Y.Doc) {
	let structs = 0, items = 0, gcs = 0, deleted = 0, liveChars = 0;
	for (const list of doc.store.clients.values()) {
		structs += list.length;
		for (const s of list) {
			if (!(s instanceof Y.Item)) { gcs++; continue; }
			items++;
			if (s.deleted) deleted++; else liveChars += s.length;
		}
	}
	return { clients: doc.store.clients.size, structs, items, gcs, deleted, liveChars };
}

/** A vault exercising every shape the real schema produces. */
function buildRealisticVault(): Y.Doc {
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	const sys = doc.getMap("sys");
	const baseClient = doc.clientID;

	doc.transact(() => { sys.set("schemaVersion", 2); });

	// Active file with flat (v2) metadata.
	doc.transact(() => {
		const t = new Y.Text();
		idToText.set("a", t);
		t.insert(0, "alpha ".repeat(500));
		meta.set("a", { path: "a.md", mtime: 1 });
	});

	// Active file with nested (v3) metadata.
	doc.transact(() => {
		const t = new Y.Text();
		idToText.set("b", t);
		t.insert(0, "beta ".repeat(500));
		const entry = new Y.Map();
		entry.set("path", "b.md");
		entry.set("mtime", 2);
		meta.set("b", entry);
	});

	// Reaped body: tombstone retained, content deleted -> GC structs.
	doc.transact(() => {
		const t = new Y.Text();
		idToText.set("c", t);
		t.insert(0, "gamma ".repeat(500));
		meta.set("c", { path: "c.md", deletedAt: 3 });
	});
	doc.transact(() => { idToText.delete("c"); });

	// Partial deletion inside a live body.
	doc.transact(() => { idToText.get("a")!.delete(0, 100); });

	// Edits from other client ids, as other devices produce.
	for (let i = 0; i < 3; i++) {
		doc.clientID = baseClient + 1 + i;
		doc.transact(() => { idToText.get("b")!.insert(0, `dev${i} `); });
	}
	doc.clientID = baseClient;

	// Rope growth: many small appends merged into one item.
	for (let i = 0; i < 500; i++) {
		doc.transact(() => { idToText.get("a")!.insert(idToText.get("a")!.length, "w "); });
	}
	return doc;
}

const textOf = (doc: Y.Doc, key: string): string | null =>
	doc.getMap<Y.Text>("idToText").get(key)?.toString() ?? null;

// ---------------------------------------------------------------------------

console.log("\n--- Test 1: the round trip is exact across every schema shape ---");
{
	const doc = buildRealisticVault();
	const before = census(doc);
	const beforeEncoded = Y.encodeStateAsUpdate(doc);

	const fresh = rematerialize(doc);
	const after = census(fresh);

	assert(textOf(fresh, "a") === textOf(doc, "a"), "flat-metadata file content identical");
	assert(textOf(fresh, "b") === textOf(doc, "b"), "nested-metadata file content identical");
	assert(!fresh.getMap("idToText").has("c"), "reaped body still absent");
	assert(fresh.getMap("meta").has("c"), "tombstone preserved");
	assert(fresh.getMap("sys").get("schemaVersion") === 2, "sys map preserved");

	const nested = fresh.getMap("meta").get("b");
	assert(nested instanceof Y.Map, "nested metadata is still a Y.Map, not flattened");
	assert((nested as Y.Map<unknown>).get("path") === "b.md", "nested metadata readable");

	for (const key of ["clients", "structs", "items", "gcs", "deleted", "liveChars"] as const) {
		assert(before[key] === after[key], `${key} unchanged (${before[key]} -> ${after[key]})`);
	}
	assert(
		Buffer.compare(Buffer.from(beforeEncoded), Buffer.from(Y.encodeStateAsUpdate(fresh))) === 0,
		"encoded state is byte-identical",
	);
	doc.destroy();
	fresh.destroy();
}

console.log("\n--- Test 2: state vectors match, so connected clients need no resync ---");
{
	const doc = buildRealisticVault();
	const client = new Y.Doc();
	Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));

	const fresh = rematerialize(doc);

	const svBefore = Buffer.from(Y.encodeStateVector(doc)).toString("hex");
	const svAfter = Buffer.from(Y.encodeStateVector(fresh)).toString("hex");
	assert(svBefore === svAfter, "state vector identical across the swap");

	// What the server sends a client after the swap must be empty: the client
	// is already up to date, so a swap must not look like new work.
	const diffForClient = Y.encodeStateAsUpdate(fresh, Y.encodeStateVector(client));
	const probe = new Y.Doc();
	Y.applyUpdate(probe, Y.encodeStateAsUpdate(client));
	Y.applyUpdate(probe, diffForClient);
	assert(textOf(probe, "a") === textOf(fresh, "a"), "client converges to the replacement");
	assert(textOf(probe, "b") === textOf(fresh, "b"), "client converges on the multi-client file");

	doc.destroy(); client.destroy(); fresh.destroy(); probe.destroy();
}

console.log("\n--- Test 3: a client editing after the swap still converges ---");
{
	const doc = buildRealisticVault();
	const client = new Y.Doc();
	Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));

	const fresh = rematerialize(doc);

	// Client edits against the pre-swap state it already had.
	client.transact(() => { client.getMap<Y.Text>("idToText").get("a")!.insert(0, "POST "); });
	const clientUpdate = Y.encodeStateAsUpdate(client, Y.encodeStateVector(fresh));
	Y.applyUpdate(fresh, clientUpdate);
	Y.applyUpdate(client, Y.encodeStateAsUpdate(fresh, Y.encodeStateVector(client)));

	assert(textOf(fresh, "a") === textOf(client, "a"), "server and client agree after a post-swap edit");
	assert(textOf(fresh, "a")!.startsWith("POST "), "the post-swap edit survived");
	doc.destroy(); client.destroy(); fresh.destroy();
}

console.log("\n--- Test 4: retargeting keeps the coordinator persisting ---");
{
	const doc = buildRealisticVault();
	const store = new MemoryDocStore();
	const coordinator = new PersistenceCoordinator(doc, store);
	await coordinator.enqueueSave();
	coordinator.setInitialStateVector(Y.encodeStateVector(doc));

	const fresh = rematerialize(doc);
	coordinator.retargetDocument(fresh);

	// An edit on the REPLACEMENT must mark the coordinator dirty; if the
	// listener were still on the discarded document it would never fire and the
	// room would silently stop persisting.
	assert(!coordinator.health.dirty, "clean immediately after retarget");
	fresh.transact(() => { fresh.getMap<Y.Text>("idToText").get("a")!.insert(0, "X"); });
	assert(coordinator.health.dirty, "an edit on the replacement marks the coordinator dirty");

	const save = await coordinator.enqueueSave();
	assert(save.method !== "skipped", `the edit was written (method=${save.method})`);

	// And a deletion on the replacement, the case that has no state-vector signal.
	fresh.transact(() => { fresh.getMap<Y.Text>("idToText").get("a")!.delete(0, 1); });
	assert(coordinator.health.dirty, "a deletion on the replacement also marks dirty");
	const deleteSave = await coordinator.enqueueSave();
	assert(deleteSave.method !== "skipped", `the deletion was written (method=${deleteSave.method})`);

	const replayed = new Y.Doc();
	if (store.snapshot) Y.applyUpdate(replayed, store.snapshot);
	for (const e of store.journal) Y.applyUpdate(replayed, e);
	assert(textOf(replayed, "a") === textOf(fresh, "a"), "storage matches the replacement document");

	coordinator.dispose();
	doc.destroy(); fresh.destroy(); replayed.destroy();
}

console.log("\n--- Test 5: retargeting detaches the old document ---");
{
	const doc = buildRealisticVault();
	const store = new MemoryDocStore();
	const coordinator = new PersistenceCoordinator(doc, store);
	await coordinator.enqueueSave();
	coordinator.setInitialStateVector(Y.encodeStateVector(doc));

	const fresh = rematerialize(doc);
	coordinator.retargetDocument(fresh);

	// Editing the discarded document must NOT mark the coordinator dirty; if it
	// did, the coordinator would persist state nobody is serving.
	doc.transact(() => { doc.getMap<Y.Text>("idToText").get("a")!.insert(0, "ZZZ"); });
	assert(!coordinator.health.dirty, "an edit on the discarded document is ignored");

	assert(coordinator.retargetDocument(fresh) === undefined, "retargeting to the same document is a no-op");
	coordinator.dispose();
	doc.destroy(); fresh.destroy();
}

// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(56)}\n`);

if (failed > 0) process.exit(1);
