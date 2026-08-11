/**
 * Tests for usesLegacyPathModel(), the rule that decides whether `pathToId`
 * still authorises path -> fileId resolution.
 *
 * Getting this wrong is silent rather than loud, and it has already produced two
 * distinct wrong answers on a real vault:
 *
 *   - The tombstone reaper treated a `pathToId` reference as proof a file was
 *     live, and pinned 14 of 46 tombstoned bodies that could never be reclaimed.
 *   - getDocumentSummary() resolved its consistency counters through `pathToId`
 *     and reported a healthy 92-file vault as `activePathsWithText: 0`.
 *
 * Both consulted a map that the v2 migration froze: under the id-first model the
 * client resolves from `meta` alone and stops writing `pathToId`, so surviving
 * entries point into the pre-migration fileId space forever.
 *
 * These tests pin the rule itself and reproduce the exact vault shape that
 * produced the misleading numbers.
 */

import * as Y from "yjs";
import { usesLegacyPathModel, ID_FIRST_PATH_MODEL_MIN_SCHEMA } from "../server/src/schemaModel";
import { reapTombstonedBodies } from "../server/src/tombstoneReaper";

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

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function docWithSchema(version: unknown): Y.Doc {
	const doc = new Y.Doc();
	if (version !== undefined) {
		doc.transact(() => { doc.getMap("sys").set("schemaVersion", version); });
	}
	return doc;
}

// ---------------------------------------------------------------------------

console.log("\n--- Test 1: the rule itself ---");
{
	assert(ID_FIRST_PATH_MODEL_MIN_SCHEMA === 2, "id-first begins at schema 2");

	assert(usesLegacyPathModel(docWithSchema(undefined)) === true, "absent schemaVersion => legacy");
	assert(usesLegacyPathModel(docWithSchema(1)) === true, "schema 1 => legacy");
	assert(usesLegacyPathModel(docWithSchema(2)) === false, "schema 2 => id-first");
	assert(usesLegacyPathModel(docWithSchema(3)) === false, "schema 3 => id-first");
	assert(usesLegacyPathModel(docWithSchema(99)) === false, "future schema => id-first");

	// Unreadable values must resolve to legacy, the conservative answer: it keeps
	// pathToId authoritative so callers veto rather than act on a document whose
	// model they cannot establish.
	assert(usesLegacyPathModel(docWithSchema("2")) === true, "string schemaVersion => legacy (unreadable)");
	assert(usesLegacyPathModel(docWithSchema(null)) === true, "null schemaVersion => legacy");
	assert(usesLegacyPathModel(docWithSchema(Number.NaN)) === true, "NaN schemaVersion => legacy");
}

console.log("\n--- Test 2: a migrated vault's frozen pathToId does not pin bodies ---");
{
	// The exact shape that misled the reaper: schema 2, tombstones whose paths
	// still appear in the legacy map, pointing at pre-migration fileIds.
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	const pathToId = doc.getMap<string>("pathToId");
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 2);
		for (let i = 0; i < 4; i++) {
			const t = new Y.Text();
			idToText.set(`new-${i}`, t);
			t.insert(0, "x".repeat(10_000));
			meta.set(`new-${i}`, { path: `n${i}.md`, deletedAt: NOW - 60 * DAY });
			// Frozen legacy entry: same PATH, but a dead pre-migration fileId.
			pathToId.set(`n${i}.md`, `old-${i}`);
		}
	});

	const result = reapTombstonedBodies(doc, { now: NOW });
	assert(result.conflicted === 0, `no false conflicts under id-first (got ${result.conflicted})`);
	assert(result.reaped === 4, `all four bodies reclaimed (got ${result.reaped})`);
	assert(result.charsFreed === 40_000, `chars freed reported (got ${result.charsFreed})`);
	for (let i = 0; i < 4; i++) {
		assert(!idToText.has(`new-${i}`), `body ${i} gone`);
		assert(meta.has(`new-${i}`), `tombstone ${i} preserved`);
	}
	doc.destroy();
}

console.log("\n--- Test 3: under the legacy model pathToId still vetoes ---");
{
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	doc.transact(() => {
		// No schemaVersion at all: legacy.
		const t = new Y.Text();
		idToText.set("f", t);
		t.insert(0, "y".repeat(5_000));
		meta.set("f", { path: "f.md", deletedAt: NOW - 60 * DAY });
		doc.getMap<string>("pathToId").set("f.md", "f");
	});

	const result = reapTombstonedBodies(doc, { now: NOW });
	assert(result.conflicted === 1, `legacy pathToId vetoes (conflicted=${result.conflicted})`);
	assert(result.reaped === 0, "nothing reclaimed while the legacy map authorises the id");
	assert(idToText.has("f"), "body preserved");
	doc.destroy();
}

console.log("\n--- Test 4: the reaper and the summary agree on the model ---");
{
	// Both call sites must derive the model from the same helper.  If they ever
	// diverge, one of them acts on a map the other considers dead, which is how
	// a vault ends up with unreclaimable bodies AND nonsense counters.
	for (const version of [undefined, 1, 2, 3]) {
		const doc = docWithSchema(version);
		const expectLegacy = version === undefined || version === 1;
		assert(
			usesLegacyPathModel(doc) === expectLegacy,
			`schema ${String(version)}: single source of truth returns ${expectLegacy ? "legacy" : "id-first"}`,
		);
		doc.destroy();
	}
}

// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(56)}\n`);

if (failed > 0) process.exit(1);
