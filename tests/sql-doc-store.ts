/**
 * Tests for SqlDocStore — validates CRUD, compaction, size limits, and
 * the KV-to-SQL migration path.
 */

import { SqlDocStore } from "../server/src/sqlDocStore";
import * as Y from "yjs";

// ── Fake SQLite storage ─────────────────────────────────────────────────────

class FakeSqlCursor<T> {
	constructor(private readonly rows: T[]) {}
	toArray(): T[] { return this.rows; }
	[Symbol.iterator](): Iterator<T> { return this.rows[Symbol.iterator](); }
}

class FakeSqlStorage {
	private tables: Map<string, Array<Record<string, unknown>>> = new Map();
	private autoIncrements: Map<string, number> = new Map();

	/**
	 * Test hook: offset applied to the snapshot_chunks byte total reported by
	 * the pre-sizing aggregate, so a disagreement between the aggregate and the
	 * row scan can be exercised.  Real SQLite cannot disagree with itself, but
	 * loadState must still fail closed if it ever does.
	 */
	snapshotTotalBias = 0;

	/** Rows handed back to the caller across every SELECT. */
	rowsRead = 0;

	/**
	 * Journal rows SQLite would have to touch.  An aggregate over `journal`
	 * returns a single row but visits the whole table (SQLite has no O(1)
	 * COUNT), and a SQLite-backed Durable Object bills rows touched — so this
	 * is the number that actually spends the free-tier read budget.
	 */
	journalRowsScanned = 0;

	/**
	 * Test hook: ground truth straight from the table, bypassing exec() so
	 * reading it never perturbs the counters above.
	 */
	journalTruth(): { entryCount: number; totalBytes: number } {
		const table = this.tables.get("journal") ?? [];
		return {
			entryCount: table.length,
			totalBytes: table.reduce((sum, row) => sum + (row.byte_length as number), 0),
		};
	}

	/** Test hook: pre-populate the journal, as a cold load would find it. */
	seedJournalRows(byteLengths: number[]): void {
		if (!this.tables.has("journal")) {
			this.tables.set("journal", []);
			this.autoIncrements.set("journal", 1);
		}
		const table = this.tables.get("journal")!;
		for (const byteLength of byteLengths) {
			const id = this.autoIncrements.get("journal")!;
			this.autoIncrements.set("journal", id + 1);
			table.push({
				id,
				data: new Uint8Array(byteLength).buffer,
				byte_length: byteLength,
				created_at: new Date().toISOString(),
			});
		}
	}

	exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): FakeSqlCursor<T> {
		const trimmed = query.trim().replace(/\s+/g, " ");

		// CREATE TABLE IF NOT EXISTS
		if (trimmed.startsWith("CREATE TABLE IF NOT EXISTS")) {
			const match = trimmed.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
			if (match && !this.tables.has(match[1])) {
				this.tables.set(match[1], []);
				this.autoIncrements.set(match[1], 1);
			}
			return new FakeSqlCursor<T>([]);
		}

		// INSERT INTO snapshot_chunks
		if (trimmed.startsWith("INSERT INTO snapshot_chunks")) {
			const table = this.tables.get("snapshot_chunks")!;
			const [chunkIndex, data] = bindings;
			table.push({ chunk_index: chunkIndex, data });
			return new FakeSqlCursor<T>([]);
		}

		// INSERT INTO journal
		if (trimmed.startsWith("INSERT INTO journal")) {
			const table = this.tables.get("journal")!;
			const [data, byteLength] = bindings;
			const id = this.autoIncrements.get("journal")!;
			this.autoIncrements.set("journal", id + 1);

			// Simulate SQLITE_TOOBIG for values >2MB
			if (data instanceof ArrayBuffer && data.byteLength > 2 * 1024 * 1024) {
				throw new Error("string or blob too big: SQLITE_TOOBIG");
			}

			table.push({ id, data, byte_length: byteLength, created_at: new Date().toISOString() });
			return new FakeSqlCursor<T>([]);
		}

		// SELECT from snapshot_chunks
		if (trimmed.startsWith("SELECT data FROM snapshot_chunks")) {
			const table = this.tables.get("snapshot_chunks") ?? [];
			const sorted = [...table].sort((a, b) => (a.chunk_index as number) - (b.chunk_index as number));
			this.rowsRead += sorted.length;
			return new FakeSqlCursor<T>(sorted as T[]);
		}

		// SELECT from journal
		if (trimmed.startsWith("SELECT data, byte_length FROM journal")) {
			const table = this.tables.get("journal") ?? [];
			const sorted = [...table].sort((a, b) => (a.id as number) - (b.id as number));
			this.rowsRead += sorted.length;
			this.journalRowsScanned += sorted.length;
			return new FakeSqlCursor<T>(sorted as T[]);
		}

		// COUNT/SUM from snapshot_chunks — used by loadState to pre-size the
		// contiguous snapshot buffer before streaming the rows.
		if (trimmed.includes("COUNT(*)") && trimmed.includes("snapshot_chunks")) {
			const table = this.tables.get("snapshot_chunks") ?? [];
			const cnt = table.length;
			const total = table.reduce(
				(sum, row) => sum + (row.data instanceof ArrayBuffer ? row.data.byteLength : 0),
				0,
			) + this.snapshotTotalBias;
			this.rowsRead += 1;
			return new FakeSqlCursor<T>([{ cnt, total } as T]);
		}

		// COUNT/SUM from journal
		if (trimmed.includes("COUNT(*)") && trimmed.includes("journal")) {
			const table = this.tables.get("journal") ?? [];
			const cnt = table.length;
			const total = table.reduce((sum, row) => sum + (row.byte_length as number), 0);
			this.rowsRead += 1;
			this.journalRowsScanned += table.length;
			return new FakeSqlCursor<T>([{ cnt, total } as T]);
		}

		// DELETE FROM
		if (trimmed.startsWith("DELETE FROM snapshot_chunks")) {
			this.tables.set("snapshot_chunks", []);
			return new FakeSqlCursor<T>([]);
		}
		if (trimmed.startsWith("DELETE FROM journal")) {
			this.tables.set("journal", []);
			this.autoIncrements.set("journal", 1);
			return new FakeSqlCursor<T>([]);
		}

		throw new Error(`FakeSqlStorage: unhandled query: ${trimmed}`);
	}
}

class FakeDurableObjectStorage {
	sql = new FakeSqlStorage();
	transactionSync<T>(closure: () => T): T {
		// Simple: just execute.  A real impl would rollback on throw.
		return closure();
	}
}

// ── Test helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  \x1b[32mPASS\x1b[0m  ${message}`);
		passed++;
	} else {
		console.log(`  \x1b[31mFAIL\x1b[0m  ${message}`);
		failed++;
	}
}

function makeDoc(fileCount: number): Y.Doc {
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");
	for (let i = 0; i < fileCount; i++) {
		meta.set(`file-${i}`, { path: `notes/file-${i}.md`, mtime: Date.now() });
	}
	return doc;
}

// ── Tests ───────────────────────────────────────────────────────────────────

console.log("\n--- Test 1: empty state ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);
	const state = store.loadState();
	assert(state.snapshot === null, "no snapshot");
	assert(state.journalUpdates.length === 0, "no journal entries");
	assert(state.journalStats.entryCount === 0, "entry count is 0");
	assert(state.journalStats.totalBytes === 0, "total bytes is 0");
}

console.log("\n--- Test 2: append and load ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	const doc = makeDoc(10);
	const update = Y.encodeStateAsUpdate(doc);
	const stats = store.appendUpdate(update);
	assert(stats !== null, "append succeeds");
	assert(stats!.entryCount === 1, `entry count is 1 (got ${stats!.entryCount})`);
	assert(stats!.totalBytes === update.byteLength, "total bytes matches");

	// Load and verify
	const state = store.loadState();
	assert(state.snapshot === null, "no snapshot yet");
	assert(state.journalUpdates.length === 1, "one journal entry");

	// Apply to a new doc and check content
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.journalUpdates[0]);
	const meta2 = doc2.getMap("meta");
	assert(meta2.size === 10, `loaded doc has 10 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 3: rewriteCheckpoint clears journal ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	const doc = makeDoc(50);
	// Append some entries
	for (let i = 0; i < 5; i++) {
		doc.getMap("meta").set(`extra-${i}`, { path: `extra-${i}.md`, mtime: Date.now() });
		store.appendUpdate(Y.encodeStateAsUpdate(doc));
	}
	const beforeStats = store.getJournalStats();
	assert(beforeStats.entryCount === 5, `5 journal entries before compact (got ${beforeStats.entryCount})`);

	// Compact
	const fullUpdate = Y.encodeStateAsUpdate(doc);
	store.rewriteCheckpoint(fullUpdate);

	const afterStats = store.getJournalStats();
	assert(afterStats.entryCount === 0, "journal cleared after checkpoint");
	assert(afterStats.totalBytes === 0, "journal bytes cleared");

	// Load and verify snapshot exists
	const state = store.loadState();
	assert(state.snapshot !== null, "snapshot exists after checkpoint");
	assert(state.journalUpdates.length === 0, "no journal after checkpoint");

	// Verify content round-trips
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.snapshot!);
	const meta2 = doc2.getMap("meta");
	assert(meta2.size === 55, `checkpoint has all 55 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 4: snapshot chunking for large docs ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Create a doc large enough to need multiple chunks (>1MB)
	const doc = new Y.Doc();
	const text = doc.getText("bigfile");
	// ~1.5MB of text content
	const bigContent = "x".repeat(1_500_000);
	text.insert(0, bigContent);

	const fullUpdate = Y.encodeStateAsUpdate(doc);
	assert(fullUpdate.byteLength > 1_000_000, `encoded doc is >1MB (got ${fullUpdate.byteLength})`);

	store.rewriteCheckpoint(fullUpdate);
	const state = store.loadState();
	assert(state.snapshot !== null, "snapshot loaded");
	assert(state.snapshot!.byteLength === fullUpdate.byteLength, "snapshot round-trips exactly");

	// Verify content
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.snapshot!);
	assert(doc2.getText("bigfile").toString().length === 1_500_000, "content preserved");
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 5: oversized delta returns null (not exception) ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Create a delta larger than 1.5MB
	const bigDelta = new Uint8Array(2 * 1024 * 1024); // 2MB
	bigDelta.fill(42);

	const result = store.appendUpdate(bigDelta);
	assert(result === null, "oversized append returns null");

	// Verify nothing was written
	const stats = store.getJournalStats();
	assert(stats.entryCount === 0, "no journal entry written for oversized delta");
}

console.log("\n--- Test 6: snapshot + journal replay produces correct state ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Write initial checkpoint
	const doc = makeDoc(100);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(doc));

	// Append additional changes as journal entries
	doc.getMap("meta").set("new-file", { path: "new.md", mtime: Date.now() });
	const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
	// Use full update relative to checkpoint for the delta
	const fullAfter = Y.encodeStateAsUpdate(doc);
	store.appendUpdate(fullAfter);

	// Load and replay
	const state = store.loadState();
	const doc2 = new Y.Doc();
	if (state.snapshot) Y.applyUpdate(doc2, state.snapshot);
	for (const u of state.journalUpdates) Y.applyUpdate(doc2, u);

	const meta2 = doc2.getMap("meta");
	assert(meta2.has("new-file"), "journal delta applied correctly");
	assert(meta2.size === 101, `final state has 101 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 7: KV-to-SQL migration simulation ---");
{
	// Simulate: SQL store is empty, ChunkedDocStore has data
	// The migration logic lives in server.ts, but we can verify the
	// SqlDocStore correctly handles "load empty → write checkpoint" flow

	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Verify empty
	const emptyState = store.loadState();
	assert(emptyState.snapshot === null, "SQL is empty before migration");

	// Simulate migration: create a doc as if loaded from KV, write to SQL
	const kvDoc = makeDoc(200);
	const kvState = Y.encodeStateAsUpdate(kvDoc);
	store.rewriteCheckpoint(kvState);

	// Verify migration succeeded
	const migratedState = store.loadState();
	assert(migratedState.snapshot !== null, "snapshot exists after migration");
	assert(migratedState.journalUpdates.length === 0, "no journal after migration");

	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, migratedState.snapshot!);
	const meta2 = doc2.getMap("meta");
	assert(meta2.size === 200, `migrated doc has 200 entries (got ${meta2.size})`);
	kvDoc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 8: snapshot size mismatch fails loudly ---");
{
	const storage = new FakeDurableObjectStorage();
	// FakeDurableObjectStorage structurally implements the subset of the DO
	// storage surface SqlDocStore uses; the worker-types interface is private.
	const store = new SqlDocStore(
		storage as unknown as ConstructorParameters<typeof SqlDocStore>[0],
	);

	const doc = makeDoc(20);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(doc));

	// A snapshot buffer sized from a wrong total would silently truncate the
	// Y.Doc update, which Yjs would then fail to decode or — worse — decode
	// partially.  loadState must refuse to return a buffer it could not fill
	// exactly, in either direction.
	storage.sql.snapshotTotalBias = -1;
	let shortMessage = "";
	try {
		store.loadState();
	} catch (err) {
		shortMessage = err instanceof Error ? err.message : String(err);
	}
	assert(
		shortMessage.includes("size mismatch"),
		`under-reported total throws (got ${shortMessage || "no throw"})`,
	);

	storage.sql.snapshotTotalBias = 1;
	let longMessage = "";
	try {
		store.loadState();
	} catch (err) {
		longMessage = err instanceof Error ? err.message : String(err);
	}
	assert(
		longMessage.includes("size mismatch"),
		`over-reported total throws (got ${longMessage || "no throw"})`,
	);

	doc.destroy();
}

console.log("\n--- Test 9: journal stats never drift from storage ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage as unknown as ConstructorParameters<typeof SqlDocStore>[0],
	);

	// getJournalStats() is now answered from in-memory counters.  They are the
	// only source of truth callers see, so the one thing that must never happen
	// is drift from the table — check against a full scan after every mutation.
	let drifts = 0;
	const checkAgainstStorage = (label: string): void => {
		const stats = store.getJournalStats();
		const truth = storage.sql.journalTruth();
		if (stats.entryCount !== truth.entryCount || stats.totalBytes !== truth.totalBytes) {
			drifts++;
			console.log(
				`    drift at ${label}: reported ${stats.entryCount}/${stats.totalBytes}, `
				+ `storage has ${truth.entryCount}/${truth.totalBytes}`,
			);
		}
	};

	checkAgainstStorage("cold instance");

	// A realistic cycle: appends of varying size, a mid-cycle load, a
	// zero-length update, and a compaction that empties the journal.
	for (let i = 1; i <= 25; i++) {
		store.appendUpdate(new Uint8Array(i * 7 + 1));
		checkAgainstStorage(`append ${i}`);

		if (i === 8) {
			store.appendUpdate(new Uint8Array(0));
			checkAgainstStorage("zero-length append");
		}
		if (i === 12) {
			store.loadState();
			checkAgainstStorage("after loadState");
		}
		if (i === 18) {
			store.rewriteCheckpoint(Y.encodeStateAsUpdate(makeDoc(5)));
			checkAgainstStorage("after rewriteCheckpoint");
		}
	}

	assert(drifts === 0, `in-memory stats match a full scan at every step (${drifts} drifts)`);

	const finalStats = store.getJournalStats();
	assert(finalStats.entryCount === 7, `7 entries survive the compaction (got ${finalStats.entryCount})`);
}

console.log("\n--- Test 10: getJournalStats is O(1) ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage as unknown as ConstructorParameters<typeof SqlDocStore>[0],
	);

	const APPENDS = 60;
	// Before the fix, appendUpdate and the explicit call each ran a COUNT/SUM
	// over the whole journal, so the Nth save touched 2N rows.
	const preChangeRows = APPENDS * (APPENDS + 1);

	storage.sql.rowsRead = 0;
	storage.sql.journalRowsScanned = 0;
	for (let i = 0; i < APPENDS; i++) {
		store.appendUpdate(new Uint8Array(64));
		store.getJournalStats();
	}

	assert(
		storage.sql.journalRowsScanned <= 4,
		`${APPENDS} save cycles touch ≤4 journal rows (got ${storage.sql.journalRowsScanned}; `
		+ `pre-change cost was ${preChangeRows} rows read)`,
	);
	assert(
		storage.sql.rowsRead <= 4,
		`${APPENDS} save cycles issue ≤4 rows of SELECT output (got ${storage.sql.rowsRead})`,
	);
	assert(
		store.getJournalStats().entryCount === APPENDS,
		"the O(1) path still reports the true entry count",
	);
}

console.log("\n--- Test 11: oversized update leaves stats untouched ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage as unknown as ConstructorParameters<typeof SqlDocStore>[0],
	);

	store.appendUpdate(new Uint8Array(100));
	store.appendUpdate(new Uint8Array(250));
	const before = store.getJournalStats();

	// Over MAX_JOURNAL_ENTRY_BYTES (1.5MB): rejected without an INSERT, so the
	// counters must not move — otherwise every oversized paste would inflate
	// them permanently and force spurious compactions.
	const rejected = store.appendUpdate(new Uint8Array(2 * 1024 * 1024));
	assert(rejected === null, "oversized append still returns null");

	const after = store.getJournalStats();
	assert(
		after.entryCount === before.entryCount && after.totalBytes === before.totalBytes,
		`stats unchanged by rejected append (${after.entryCount}/${after.totalBytes})`,
	);
	const truth = storage.sql.journalTruth();
	assert(
		after.entryCount === truth.entryCount && after.totalBytes === truth.totalBytes,
		"stats still match storage after a rejected append",
	);
}

console.log("\n--- Test 12: rewriteCheckpoint resets the counters ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage as unknown as ConstructorParameters<typeof SqlDocStore>[0],
	);

	for (let i = 0; i < 5; i++) store.appendUpdate(new Uint8Array(128));
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(makeDoc(3)));

	const cleared = store.getJournalStats();
	assert(cleared.entryCount === 0, `entryCount zeroed by checkpoint (got ${cleared.entryCount})`);
	assert(cleared.totalBytes === 0, `totalBytes zeroed by checkpoint (got ${cleared.totalBytes})`);

	const next = store.appendUpdate(new Uint8Array(42));
	assert(next?.entryCount === 1, `first post-checkpoint append reports 1 entry (got ${next?.entryCount})`);
	assert(next?.totalBytes === 42, `first post-checkpoint append reports 42 bytes (got ${next?.totalBytes})`);
}

console.log("\n--- Test 13: stats seed lazily from an existing journal ---");
{
	const storage = new FakeDurableObjectStorage();
	storage.sql.seedJournalRows([10, 20, 30]);
	const store = new SqlDocStore(
		storage as unknown as ConstructorParameters<typeof SqlDocStore>[0],
	);

	// A fresh instance over a warm journal (the cold-start case) must not
	// report zero just because it has not loaded yet.
	storage.sql.journalRowsScanned = 0;
	const seeded = store.getJournalStats();
	assert(seeded.entryCount === 3, `seeded entryCount from storage (got ${seeded.entryCount})`);
	assert(seeded.totalBytes === 60, `seeded totalBytes from storage (got ${seeded.totalBytes})`);

	const afterFirstCall = storage.sql.journalRowsScanned;
	store.getJournalStats();
	store.getJournalStats();
	assert(
		storage.sql.journalRowsScanned === afterFirstCall,
		`seed scan runs at most once per instance (${afterFirstCall} rows, then ${storage.sql.journalRowsScanned})`,
	);

	const grown = store.appendUpdate(new Uint8Array(5));
	assert(grown?.entryCount === 4 && grown?.totalBytes === 65, `append builds on the seed (got ${grown?.entryCount}/${grown?.totalBytes})`);
}

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) process.exit(1);
