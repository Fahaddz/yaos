# Checkpoint & Journal Architecture

A naive CRDT persistence layer rewrites the entire state graph on every save. To avoid catastrophic write-amplification, YAOS implements a checkpoint and journal architecture.

## Migration reality check (PartyKit -> y-partyserver)

Under the old PartyKit stack, persistence behavior came with hidden infrastructure:

- append-style update logging
- internal chunked storage writes
- periodic update-log compaction

That made large-document survival feel "automatic" even when application code was simple.

During the migration to `y-partyserver`, we initially assumed those durability mechanics were still present because both stacks expose Yjs server primitives and similar integration ergonomics. That assumption was wrong.

`y-partyserver` gives us transport, room wiring, and debounced `onSave()` / `onLoad()` hooks. It does not provide built-in chunked persistence, checkpoint manifests, journal compaction, or state-vector anchoring. Once we verified this at the implementation level, the risk became clear: we were one step away from full-state rewrites on each save and the exact write-amplification failure mode that kills CRDT deployments at scale.

We also validated framework behavior directly: `y-partyserver` gives us `onLoad()` / `onSave()` hooks, but it does not provide automatic persistence chunking like older PartyKit flows.

This was the architectural inflection point: we stopped treating persistence like plugin glue code and treated it like a storage engine problem. In practice, this was the "final boss" of CRDT scaling: write amplification plus hibernation-safe state-vector recovery.

## What we built

The engine is a two-layer persistence model: a checkpoint holding compacted full state, and a journal of coalesced deltas appended on top of it. That shape has outlived its first implementation.

The live store is [`server/src/sqlDocStore.ts`](../../server/src/sqlDocStore.ts), backed by Durable Object SQLite:

1. Checkpoint layer
- full-state snapshot written to `snapshot_chunks`, one row per 1 MB slice
- rewritten wholesale inside a single `transactionSync()`, so a compaction is atomic

2. Journal layer
- coalesced delta segments appended in sequence to `journal`, capped at 1.5 MB per row
- journal stats (`entryCount`, `totalBytes`) read out of the table itself rather than maintained as a separate metadata record that can disagree with it

Both caps exist for one reason: SQLite in a Durable Object refuses a value over 2 MB. 1 MB for snapshot rows is a round number comfortably under it; 1.5 MB for a journal row leaves margin for encoding overhead on a delta whose size we did not choose.

The original implementation, [`server/src/chunkedDocStore.ts`](../../server/src/chunkedDocStore.ts), hand-rolled the same shape over the KV storage API: 64 KB chunks, versioned manifests, pointer indirection, SHA-256 over every chunk, and batching at 128 keys per operation because there was no transaction to lean on. It is still in the tree and it is now read-only. Two paths reach it. A room that has never been migrated loads from KV once, is rewritten as a verified SQL checkpoint, and never comes back. A room whose SQL load throws falls back to KV so it stays readable instead of failing closed on a corrupt table. Neither path writes new KV state.

If you are taking a chunk size out of this document, it is 1 MB. The 64 KB figure describes storage that no live room writes to.

This is chunking at the I/O boundary: the in-memory document can stay monolithic while storage writes are partitioned into bounded segments. The result is an MVCC-like write shape: append small deltas most of the time, periodically compact into a new checkpoint.

## Write path

A save, coordinated by [`server/src/persistenceCoordinator.ts`](../../server/src/persistenceCoordinator.ts) on behalf of [`server/src/server.ts`](../../server/src/server.ts):

1. Returns immediately if the document is not dirty — an update-driven flag, not a state-vector comparison. See below; the distinction is load-bearing.
2. Takes the update payloads Yjs handed the coordinator when the transactions ran, and merges them into one delta. This is the fast path, and it is O(change): the bytes already exist, so nothing walks the document to rediscover them. Three cases fall back to `Y.encodeStateAsUpdate(doc, baselineStateVector)`, which is O(document) but derives the delta from what storage actually holds and so cannot inherit a hole in the buffer — no persisted baseline yet, a dirty document with an empty buffer (an update the coordinator never observed), or a merge that throws.
3. Appends the delta to the journal.
4. Relieves journal pressure, by the kind of pressure it is:
- **entry count** above 50 makes cold load slow, because replay cost is dominated by the number of `applyUpdate` calls rather than by bytes. Answered by coalescing the journal into a single row — O(journal).
- **journal bytes** above `max(1 MB, snapshot / 4)` makes writes wasteful. Answered by a checkpoint — O(snapshot).

Answering entry-count pressure with a checkpoint, as this engine did until recently, rewrites the whole vault to relieve a few KB of deltas, and does it proportionally more often the larger the vault gets. Measured against duplicated real content: 1,022x write amplification at 3 MB, 4,063x at 12 MB, 16,231x at 48 MB, because typing produces ~83-byte deltas and so the 50-entry rule always fired long before the 1 MB one. Splitting the two answers takes steady-state full-document encodes to zero and makes save cost flat in vault size (~20 ms per 1,200 saves at every size from 3 MB to 48 MB, against 741 ms at 48 MB before).

Merging is worth doing once at write time and never at read time: `Y.mergeUpdates` decodes and re-encodes every entry, so collapsing a 4,000-row journal during `loadState` cost 143 ms to save 10 ms of apply. Coalescing pays that once, amortised over the saves that produced the rows, and leaves a one-row journal for every subsequent load.

Two conditions skip the journal entirely and rewrite the checkpoint directly:

- the delta exceeds 2 MB, at which point journaling it is pointless — it is approaching full state anyway and would not fit a row; and
- two consecutive append failures, on the theory that a journal we cannot append to is not a journal.

All persistence writes are serialized through `saveChain` so journal sequence ordering is deterministic.

## The save gate: why a state vector cannot decide

Step 1 above used to read differently: compute the document's state vector, compare it to the last persisted one, skip the save if they matched. It looks like an obvious optimisation. It is a data-loss bug.

A Yjs state vector maps client ID to that client's highest clock. It describes inserts, and only inserts. Deletions advance no clock; they live in the delete set, which the state vector says nothing about. Two byte-identical state vectors can therefore describe documents differing by an arbitrary number of deletions, up to and including all of them.

So every deletion-only change was silently dropped while the save reported success. Select all, delete, save: the state vector comes back byte-identical, the coordinator skips the write, storage still holds the text, and the next cold load resurrects it.

We watched this in production. A client reaped 40 tombstoned bodies, the server logged `save.skipped_equal_sv`, and the room reverted to 178 texts while the client held 138 — both sides reporting themselves synced, because by the only measure either was checking, they were. It healed only when the client reconnected and sync step 2 retransmitted the delete set.

Saves are now gated on a `dirty` flag driven by the Y.Doc `update` event, which fires for deletions exactly as it does for inserts. Three details make that safe rather than merely different:

- `dirty` defaults to true. Ambiguity resolves toward writing: a redundant save costs one journal row, a missed save loses data.
- It is cleared *before* encoding rather than after the write lands, so a change arriving mid-save re-marks the document instead of being swallowed by the save it raced.
- It is re-armed on failure, so a failed append retries on the next save instead of being treated as already persisted.

State vectors are still compared, but only to pick the delta baseline. Never to decide whether to write.

## Removing content is not the same as reclaiming it

The journal is replayed verbatim on every cold load, which makes deletion asymmetric with insertion. Appending a delta that removes content leaves the entries that *inserted* that content sitting in the journal, and they get replayed on the next load. The document still converges to the right answer — the delete set wins — but the bytes never leave storage and the replay cost never goes away.

Reclamation therefore requires the checkpoint to be rewritten, not merely a delta appended. After a tombstone reap the coordinator calls `forceCheckpoint()`, which rebuilds the snapshot from the current document and clears the journal regardless of delta size or dirty state. That is the step that makes freed space actually free.

## Load/recovery path

On load (including post-hibernation):

1. Size the snapshot with an aggregate query over `snapshot_chunks` and allocate once.
2. Stream the chunk cursor in `chunk_index` order, copying each row straight into place, so peak memory is the snapshot plus one chunk rather than twice the snapshot.
3. Read the journal in `id` order.
4. Apply the snapshot, then each journal entry in sequence.

Integrity is SQLite's problem now, which is much of why we moved: a compaction is one `transactionSync()`, so no room ever observes a half-written checkpoint, and row order *is* the sequence.

The legacy KV path still validates the old way when it is reached — checkpoint pointer, manifest, chunk layout, and SHA-256 over every reassembled payload — and fails closed if anything is missing, malformed, out-of-sequence, or hash-mismatched.

## Correctness rules (non-negotiable)

- No partial replay on corruption.
- No out-of-order journal persistence.
- No implicit trust of in-memory baseline across hibernation.
- No oversized single storage operation: snapshot rows cap at 1 MB and journal rows at 1.5 MB, both under SQLite's 2 MB value limit. (The legacy KV path batched at 128 keys per get/put/delete for the same reason.)
- No save decided by comparing state vectors.

## Why coalesced deltas (instead of per-event appends)

`y-partykit`-style per-event append can be correct, but it generates high operation counts for note-taking workloads.

YAOS chooses coalescing at `onSave()` cadence:

- lower IOPS and lower storage thrash
- much better fit for personal markdown editing bursts
- acceptable durability lag window for this product class

Write-amplification effect (order-of-magnitude example):

- old path: 50 MB vault + one character edit => near full 50 MB rewrite on save
- current path: 50 MB vault + one character edit => tiny coalesced delta append (often hundreds of bytes)

## Limits and what still hurts

Chunking removes the old single-value bottleneck, but it does not make the system infinite:

- large vaults still pay CPU cost for encode/merge/compaction
- replay size affects cold-start latency
- mobile clients still have parse/apply constraints even if transport limits are larger

Cloudflare transport limits improved over time, but network headroom is not the same as client headroom. A large payload that fits in transport can still be expensive for mobile parse/apply and UI responsiveness.

So the architectural ceiling has moved from "immediate storage crash" to "compute and memory behavior at very large scale," which is the correct class of bottleneck for this system.

Memory is now the ceiling that binds, and it is not the one you would guess from storage size. See [Memory footprint](./memory-footprint.md).

## Follow-up: what this engine did not solve

Later Durable Object hardening work is worth naming explicitly so future readers
do not over-attribute responsibilities to the checkpoint/journal engine.

The checkpoint/journal design solved the **write-shape** problem for the
monolithic room document. It did not automatically solve:

- full-document decode on websocket schema admission
- observability storage shape outside the document engine
- duplicate room-load work during concurrent cold start

Those issues were addressed separately via:

- lightweight `roomMeta` for schema admission
- bounded per-entry trace storage
- single-flight room load gating

This distinction matters because the write *shape* was already correct; the
remaining work lived on the admission, observability, and lifecycle paths. The
one defect that did belong to this engine was in the save *decision*, not the
write shape: the state-vector gate described above.

## Current status

The storage engine now has:

- checkpoints chunked into 1 MB SQLite rows, rewritten transactionally
- state-vector-anchored delta journaling
- deterministic threshold compaction, with a direct-checkpoint fallback
- saves gated on an update-driven dirty flag, so deletions actually persist
- forced checkpointing after content removal, so reclamation survives replay
- strict integrity validation on the legacy KV read path
- serialized persistence ordering

This is the foundation for a production-grade monolithic CRDT backend on Cloudflare Workers.
