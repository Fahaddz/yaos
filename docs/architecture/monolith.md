# Monolithic Architecture

The current YAOS architecture uses a single, shared Y.Doc for the entire vault - file metadata, folder structures, blob references, and all markdown Y.Text values.

![Single-vault monolithic Y.Doc vs sharded two-tier CRDT model](../diagrams/single-vault-monolithic-y-doc-vs-sharded-two-tier-crdt-model.webp)

For personal vaults edited the way people actually edit — see the ceiling discussion below, which is about struct count rather than vault size — this gives:

- simple synchronization semantics
- strong real-time collaboration behavior
- easy snapshotting
- and perfect cross-vault ACID transactions.

If a user renames a folder containing 50 markdown files, YAOS batches that into a single ydoc.transact() block. Either all 50 files move, or none of them move. The vault structure can't tear.

The tradeoff is that this design has a scaling ceiling, and the ceiling is memory rather than disk. One vault means one in-memory Y.Doc, and a Durable Object isolate gets 128 MB.

**The ceiling is not measured in bytes of text. It is measured in structs.**

A Yjs struct — one item in the CRDT — costs roughly 117 bytes of heap. What decides how many structs a vault has is not its size but how its edits are shaped, because Yjs merges consecutive inserts from the same client into one item and cannot merge anything else. Three measurements from the same instrument make the point:

| vault | characters | structs |
| --- | --- | --- |
| 12.5 MB, freshly synced | 12,512,428 | 3,318 |
| a real vault after months of ordinary editing | 3,533,111 | 2,094 |
| the same 12.5 MB vault after 30,000 scattered edits | 12,566,428 | 33,444 |

12.5 MB of text costs 3,318 structs. Thirty thousand edits that rotate between notes cost 30,115 more, one per edit, because none of them can merge. At ~117 bytes each, roughly 100 MB of usable heap is about **850,000 structs**.

So a user can paste a 12 MB file and pay almost nothing, while a script that appends one character to 5,000 files every minute will exhaust the object in hours. This is an entropy limit, not a capacity limit, and it is monotonic: fragmented structs never merge later.

### What we thought the ceiling was

For a while we believed the dominant cost was a V8 rope. Yjs merges adjacent inserts by concatenating their strings, and V8 answers `str += str` with a cons node rather than a flat string, so a synthetic document built by inserting one character at a time costs ~32 bytes per character instead of ~1.2.

That effect is real but does not occur here, because **`Y.encodeStateAsUpdate` flattens the ropes as a side effect** — it reads every string, and V8 materialises the flat form. Everything in this system encodes constantly. The server encodes on every debounced save; the client's y-indexeddb layer periodically encodes to trim its update log. Measured on 1M characters: 30.9 MiB with no saves, 1.15 MiB with one delta encode per 2,000 updates. A soak of a live 12.5 MB vault driven through Obsidian with the full save path running reclaimed **0.02 MiB** of rope after 20,602 updates.

Re-materialising the document — encoding its own state and decoding it into a fresh Y.Doc — therefore reclaims nothing that the save path has not already reclaimed. On a fragmented document it is actively harmful: struct count is unchanged by the round trip, and heap measured **15% worse**, because the rebuild loads the persisted state before the previous allocation is released.

It has been removed entirely rather than left as a manual escape hatch. The situation that would tempt an operator into running it — a vault climbing toward the memory limit — is by definition the fragmented one, and there the swap needs the old document, the encoded update and the new document resident simultaneously. It would spike the object it was invoked to save. See `scripts/bench-interventions.mjs`.

Tombstones and history pay rent too, but less than we feared, and we now collect some of it back: once a file has been tombstoned long enough, its Y.Text body is reclaimed while the tombstone itself is kept, so deleted files stop carrying their content without breaking delete propagation to devices that were offline.

We estimate that 70-80% of Obsidian users write notes like normal humans and want a fast, local-first Apple-Notes-on-steroids alternative. But we acknowledge that the small group of users who use Obsidian to ingest 10,000 auto-generated logs, scrape Wikipedia, and dump gigabytes of academic PDFs into one folder.

Loading a 10GB vault's history into a single in-memory CRDT graph would immediately trigger an Out of Memory crash on mobile devices. This is why Obsidian Sync uses dumb, debounced file-level syncing, because it has an O(1) memory ceiling per file. It doesn't care if your vault is 1MB or 50GB; it just moves files around and relies on "File modified externally" popups when things collide.

We made the opposite trade. YAOS trades infinite scalability for perfect real-time ergonomics.

To bypass the memory ceiling while keeping real-time sync, *we could shard the CRDT per-file*, which is actually how Apple Notes works:

- Local-First Database: The source of truth is a local SQLite database (CoreData). The folder structure, metadata, and note list live here.
- Per-Note CRDTs: Apple does use a custom CRDT implementation for the rich text and tables inside the notes, but it is strictly scoped per note. They serialize the note content using Protocol Buffers and sync it via CloudKit.
- Dumb Metadata Sync: The folder hierarchy and note metadata (creation date, tags) do not use CRDTs. They use standard CloudKit conflict resolution, which is usually just Last-Writer-Wins (LWW) based on timestamps.
- Aggressive Garbage Collection: Unlike Yjs, which retains every deletion tombstone forever (unless you explicitly write a garbage collection layer), Apple Notes aggressively prunes edit history once the CloudKit server confirms the sync. This keeps the protocol buffer payloads tiny.

To achieve this in YAOS, we would have to build a Two-Tier CRDT System:

**Tier 1 (The Master Index)**: A vault-level CRDT holding only metadata (fileID -> path). It syncs immediately on startup.

**Tier 2 (Lazy-Loaded Leaf Docs)**: Each markdown file gets a dedicated Y.Doc. When a user opens foo.md, the client dynamically instantiates the doc, fetches its history, and subscribes to its updates.

We don't do this because this is a major refactor with complex consistency boundaries, and Apple's custom CRDT is actually worse at handling heavy concurrent edits than my Yjs implementation. Yjs is mathematically more robust.

Because browsers only allow a few WebSocket connections, this requires building a custom multiplexed router, and we would have to build an LRU to constantly evict idle Y.Doc instances from memory (because the nature of the Actor model is such that individual objects have small limits).

The problem is, when you split a single monolithic state graph into thousands of independent CRDT instances, you fundamentally decouple their replication streams. A multi-document operation, such as updating a structural reference in the Master Index while simultaneously modifying the target Leaf Doc—can no longer be committed as a single atomic transaction.

If a network partition interrupts the synchronization process, the system state tears. Document A may successfully replicate to the remote server while Document B remains stranded on the local client. To a remote observer, the vault's referential integrity is broken. Links between documents can break, metadata no longer lines up with the actual content, and related changes show up in the wrong order.

By sharding the state, you downgrade the system's cross-vault guarantees from *strong transactional consistency to eventual consistency*. The CRDTs will mathematically converge once the network fully stabilizes, but the intermediate states exposed to the system, and the user, will be semantically invalid.

Enterprise systems like Figma and Notion accept this tearing. They trade strong consistency for identity preservation and memory scalability. Because the content is bound to a stable fileID rather than a fragile file path, no data is permanently lost. However, they write defensive UI code to hide broken references, handle dangling pointers, and mask the eventual consistency delay from the user.

YAOS has a debug mode, which shows vault-footprint. After doing QA, I saw that my vault's `encodedDocBytes` was 25KB larger than the total live markdown text, which is roughly a **1.9% overhead.** Essentially, the CRDT state is lean, and history/tombstones are not bloating the document much at all.

That figure is about *encoded* size — what the CRDT costs on the wire and in storage — and it still holds. It is not a memory number, and the two diverge: encoded size tracks characters, while memory tracks structs. A vault can be lean on the wire and expensive in RAM at the same time, which is exactly what a heavily fragmented vault is.

So the honest position is narrower than "cherish the monolith". The rope scare turned out to be an artefact that the save path already handles, which is a point in the monolith's favour. Struct growth did not: it is architectural, it is monotonic, and nothing at the application layer reclaims it. A monolithic Y.Doc holds every struct the vault has ever fragmented into, for as long as the object is resident.

That is the one argument for lazy-loaded subdocuments that survives measurement, because eviction is the only mechanism that removes structs from memory — close a note and its structs leave with it. See `docs/rfcs/lazy-body-subdocs.md`. Until a real vault approaches the struct ceiling the monolith is still the right trade, but the thing to watch is `structs` in the debug footprint, not megabytes.
