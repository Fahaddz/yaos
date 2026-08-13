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
import { usesLegacyPathModel, ID_FIRST_PATH_MODEL_MIN_SCHEMA } from "../../server/src/schemaModel";
import { reapTombstonedBodies } from "../../server/src/tombstoneReaper";
import { buildDocumentSummary } from "../../server/src/documentSummary";

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

console.log("\n--- Test 5: the real vault's numbers, before and after ---");
{
	// Reproduces the shape that produced the misleading report: schema 2, 92
	// active files each with a body, 46 tombstones each still holding a body
	// (nothing past the grace window yet), and 82 frozen pathToId entries left
	// by the v1->v2 migration pointing at dead pre-migration fileIds.
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	const pathToId = doc.getMap<string>("pathToId");
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 2);
		for (let i = 0; i < 92; i++) {
			const id = `live-${i}`;
			const t = new Y.Text();
			idToText.set(id, t);
			t.insert(0, "content");
			meta.set(id, { path: `a${i}.md`, mtime: 1 });
		}
		for (let i = 0; i < 46; i++) {
			const id = `dead-${i}`;
			const t = new Y.Text();
			idToText.set(id, t);
			t.insert(0, "old content");
			meta.set(id, { path: `d${i}.md`, deletedAt: 1 });
		}
		// 61 stale entries on live paths + 21 on paths with no active meta = 82.
		for (let i = 0; i < 61; i++) pathToId.set(`a${i}.md`, `premigration-${i}`);
		for (let i = 0; i < 21; i++) pathToId.set(`gone${i}.md`, `premigration-x${i}`);
	});

	const s = buildDocumentSummary(doc);

	assert(s.pathModel === "id-first", `model reported (got ${s.pathModel})`);
	assert(s.activePathCount === 92, `activePathCount 92 (got ${s.activePathCount})`);
	assert(s.tombstonedPathCount === 46, `tombstonedPathCount 46 (got ${s.tombstonedPathCount})`);
	assert(s.metaCount === 138 && s.idToTextCount === 138, "metaCount and idToTextCount both 138");
	assert(s.pathToIdCount === 82, `pathToIdCount 82 (got ${s.pathToIdCount})`);

	// The fix: every active file resolves to its own body via the metadata key.
	assert(s.activePathsWithText === 92, `all 92 active files have text (got ${s.activePathsWithText})`);
	assert(s.activePathsMissingText === 0, `none missing text (got ${s.activePathsMissingText})`);
	assert(
		s.activePathsMissingFromPathToId === 0,
		`pathToId is not consulted under id-first (got ${s.activePathsMissingFromPathToId})`,
	);
	// Stale residue is still reported, but now interpretable via pathModel.
	assert(
		s.pathToIdWithoutActiveMeta === 21,
		`frozen pathToId residue still visible (got ${s.pathToIdWithoutActiveMeta})`,
	);
	assert(s.flatMetaEntries === 138 && s.nestedMetaEntries === 0, "all metadata still flat (v2)");
	assert(s.invalidMetaEntries === 0, "no invalid entries");

	// And the old rule, reproduced by declaring the same document legacy, gives
	// back exactly the numbers that were reported from production.
	doc.transact(() => { doc.getMap("sys").set("schemaVersion", 1); });
	const legacy = buildDocumentSummary(doc);
	assert(legacy.pathModel === "legacy", "same document, legacy model");
	assert(legacy.activePathsWithText === 0, `legacy rule reproduces activePathsWithText 0 (got ${legacy.activePathsWithText})`);
	assert(
		legacy.activePathsMissingFromPathToId === 31,
		`legacy rule reproduces 31 missing-from-pathToId (got ${legacy.activePathsMissingFromPathToId})`,
	);
	assert(
		legacy.activePathsMissingText === 61,
		`legacy rule reproduces 61 missing-text (got ${legacy.activePathsMissingText})`,
	);
	assert(
		legacy.activePathsMissingFromPathToId + legacy.activePathsMissingText + legacy.activePathsWithText === 92,
		"the three counters still partition activePathCount",
	);
	doc.destroy();
}

console.log("\n--- Test 6: nested (v3) metadata is classified without instanceof ---");
{
	const doc = new Y.Doc();
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 3);
		const t = new Y.Text();
		doc.getMap<Y.Text>("idToText").set("n1", t);
		t.insert(0, "body");
		const entry = new Y.Map();
		entry.set("path", "n.md");
		entry.set("mtime", 1);
		doc.getMap("meta").set("n1", entry);

		const tombText = new Y.Text();
		doc.getMap<Y.Text>("idToText").set("n2", tombText);
		tombText.insert(0, "old");
		const tomb = new Y.Map();
		tomb.set("path", "t.md");
		tomb.set("deletedAt", 5);
		doc.getMap("meta").set("n2", tomb);
	});

	const s = buildDocumentSummary(doc);
	assert(s.nestedMetaEntries === 2, `both entries seen as nested (got ${s.nestedMetaEntries})`);
	assert(s.flatMetaEntries === 0, "none misclassified as flat");
	assert(s.activePathCount === 1, `one active (got ${s.activePathCount})`);
	assert(s.tombstonedPathCount === 1, `one tombstoned (got ${s.tombstonedPathCount})`);
	assert(s.activePathsWithText === 1, `nested active file resolves to its body (got ${s.activePathsWithText})`);
	doc.destroy();
}

console.log("\n--- Test 7: unreadable metadata is counted, not silently dropped ---");
{
	const doc = new Y.Doc();
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 2);
		doc.getMap("meta").set("bad", { mtime: 1 });        // no path
		doc.getMap("meta").set("worse", "not-an-object");
	});
	const s = buildDocumentSummary(doc);
	assert(s.invalidMetaEntries === 2, `both invalid entries counted (got ${s.invalidMetaEntries})`);
	assert(s.activePathCount === 0 && s.tombstonedPathCount === 0,
		"invalid entries are in neither active nor tombstoned");
	assert(s.metaCount === 2, "raw metaCount still reports them");
	doc.destroy();
}

// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(56)}\n`);

if (failed > 0) process.exit(1);
