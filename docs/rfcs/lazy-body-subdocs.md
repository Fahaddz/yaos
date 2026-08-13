# RFC: Lazy-loaded note bodies via Yjs subdocuments

**Status:** Draft — not scheduled. Written to be argued with, not executed.
**Supersedes the "Two-Tier CRDT" discussion in** `docs/architecture/monolith.md`.

## Summary

Split the vault document along the seam that already exists in the data: keep
`meta`, `pathToId`, `pathToBlob`, `blobMeta` and `blobTombstones` in one
always-resident Y.Doc, and move each note's `Y.Text` body into its own Yjs
subdocument, loaded when the note is opened and evicted when it is not.

This removes the vault size ceiling rather than raising it. Memory becomes a
function of the working set — how many notes are open — instead of the vault.

## Why this is being reconsidered

`monolith.md` rejected a two-tier model. That rejection was correct for the
design it described and is weaker against this one, for reasons that only
became visible after measurement.

**What we now know that we did not then:**

- The ceiling is memory, not disk — but it is a **struct count**, not a byte
  count: ~117 bytes per unmergeable struct, ~850,000 structs against ~100 MB of
  usable heap. Cold load is cheap (1.16 B/char ASCII, 2.1 UTF-16).
- The drift we originally blamed — a V8 rope artefact — does not occur in
  production, because `Y.encodeStateAsUpdate` flattens ropes and the save path
  encodes constantly. Re-materialisation was removed; it reclaimed nothing and
  measured 15% worse on a fragmented document. What remains is item
  fragmentation, which no re-encode can undo. See `monolith.md`.
- Therefore **the immediate crisis is over**. This RFC is not urgent. It is the
  answer to "what if 28 MB is not enough", and should be judged as such.

**The three original objections, revisited:**

| Objection (`monolith.md`) | Status |
| --- | --- |
| "Browsers only allow a few WebSocket connections, this requires building a custom multiplexed router" | **Dissolved.** One Durable Object, one socket. The DO already multiplexes every room's traffic; subdoc updates are just more messages on the same wire. |
| "We would have to build an LRU to constantly evict idle Y.Doc instances" | **Overstated.** This is a `Map` with a size cap and a close-on-evict. It is a genuine piece of work, not a research problem. |
| "Sharding downgrades cross-vault guarantees from strong transactional consistency to eventual consistency" | **Still true, but it does not bite here.** See below. |

## The seam argument

This is the crux of the RFC.

The atomicity `monolith.md` defends is about *structure*: renaming a folder of
50 files must move all 50 or none, or "the vault structure can't tear". That
guarantee lives entirely in `meta` and `pathToId`.

The memory cost lives entirely in `idToText`.

**These sets are disjoint.** A folder rename rewrites path→id mappings and
metadata. It does not touch a single character of any `Y.Text`. Nor does a
delete (`handleDelete` writes a tombstone and never opens the body), a blob
reference update, or a schema migration.

So the split can be made exactly along the boundary that the atomicity argument
does not cross:

```
Tier 1  (one Y.Doc, always resident, ~KB)
  meta, pathToId, pathToBlob, blobMeta, blobTombstones, sys
  -> every multi-file operation stays inside one ydoc.transact()
  -> folder renames remain atomic, exactly as today

Tier 2  (one subdoc per note, loaded on demand, evicted when idle)
  the Y.Text body
  -> never participates in a cross-file transaction today
```

What genuinely becomes eventually-consistent is the relationship *between* a
path and its body — a note can exist in the index before its body has loaded.
That is already true of every remote note on a fresh device, and the client
already handles it: `DiskMirror` fails safe when a body is unavailable, and
`documentSummary` already counts `activePathsMissingText` as a real state.

## Design

### Structure

```ts
// Tier 1, unchanged root maps plus one:
idToBody: Y.Map<Y.Doc>   // fileId -> subdoc, replacing idToText: Y.Map<Y.Text>

// Tier 2, inside each subdoc:
doc.getText("body")
```

Yjs supports `Y.Doc` as a `Y.Map` value natively. Subdocs are not loaded when
the parent loads; the parent carries only a GUID reference until something calls
`subdoc.load()`, which is exactly the laziness this needs.

### Server

The DO holds Tier 1 permanently and an LRU of open Tier 2 docs. Persistence
gains a per-subdoc dimension: today `snapshot_chunks` holds one document, and it
would hold one row-set per subdoc keyed by GUID. `SqlDocStore` already chunks by
`chunk_index`; this adds a `doc_id` column.

The tombstone reaper becomes simpler and stronger — reclaiming a body becomes
dropping its rows, not deleting Y.Text items and hoping for GC.

Eviction becomes the mechanism that removes structs from memory: close a note
and its structs leave with it. That is the one argument here that survives
measurement, since fragmentation is otherwise monotonic.

### Client

Largest change, and the reason this is not a weekend.

- The editor binding must `await` a subdoc load before binding. Today
  `idToText.get(id)` is synchronous; it becomes a promise. Every caller in the
  bind path is affected.
- The LRU must not evict a subdoc with a live editor binding, an in-flight
  write, or unsaved local changes.
- IndexedDB persistence is per-document in `y-indexeddb`, so this becomes one
  IDB store per subdoc, or a custom provider.
- Reconciliation currently walks every path and compares against disk. Doing
  that with lazy bodies means either loading everything — defeating the point —
  or reconciling on metadata (`mtime`, hash) and only loading bodies on
  suspicion. This is the single largest piece of design work in the RFC.

### Migration

One-way, server-side, at cold load: for each `idToText` entry, create a subdoc,
copy the text, delete the original. Bump `SCHEMA_VERSION`; the existing
admission gate (`SERVER_SCHEMA_VERSION`) already refuses older clients, so
the failure mode is "update your plugin" rather than corruption.

Copying the text **discards that note's edit history**, since the content is
re-inserted under fresh item IDs. Acceptable — YAOS does not surface per-note
CRDT history — but it must be stated, and it means the migration is not
reversible.

## What this costs

- Every read of a note body becomes asynchronous. This is the change that will
  find bugs, because the current code assumes synchronous availability in
  dozens of places.
- Reconciliation must be redesigned to avoid loading the vault it is trying not
  to load.
- Persistence, snapshots and the reaper all gain a per-document dimension.
- A schema migration that cannot be rolled back.
- The debugging story gets worse: "which subdoc is loaded" becomes a question
  you have to be able to answer in production, so the census work would need
  extending.

## Alternatives

**Do nothing.** Defensible. 28 MB is roughly 10,000-25,000 notes; users past
that are the log-dumpers `monolith.md` explicitly declines to serve. The
strongest counter-argument is not the ceiling but the *failure mode* at it —
OOM, DO reset, retry, silently, with no telemetry. Which suggests a much cheaper
intervention: **detect and warn near the ceiling** rather than remove it.

**Columnar CRDT (Loro, diamond-types).** Flat typed arrays instead of a JS
object graph; 10-50x less memory for identical state. Strictly better on the
metric, and it makes the whole question disappear. It is also a rewrite that
abandons the Yjs ecosystem — y-codemirror, y-indexeddb, y-partyserver,
awareness — all of which YAOS depends on heavily. Only worth it if lazy loading
also proves insufficient.

**Cap the vault.** Refuse to sync beyond a measured size, loudly, at onboarding.
Ugly, honest, and an hour of work. Worth doing regardless of this RFC, because
it converts a silent failure into a legible one.

## Recommendation

**Do not build this yet.** In order:

1. Ship a ceiling warning. The unacceptable thing today is silent OOM, not the
   size of the number. Cheap, and it is the only item here that prevents data
   loss.
2. Measure the mobile client ceiling. It is plausibly lower than the server's
   and nobody has looked; if it is, this RFC targets the wrong tier.
3. Re-evaluate against real struct-count curves from production, not synthetic
   corpora. The measured ceiling may move again.

Build this when a real user with a vault we want to serve hits the ceiling, and
the warning from step 1 tells us how often that happens. Not before — the
migration is one-way and the async-body change touches everything.

## Open questions

- Does `y-partyserver` sync subdocs, or does the provider need extending?
  Yjs has the protocol; the server framework may not implement it.
- Can `y-indexeddb` hold many small documents without pathological IDB
  behaviour, or does this need a custom persistence provider?
- How does awareness (cursors) interact with subdocs a peer has not loaded?
- What is the right LRU size, and is it a byte budget rather than a count?
- Does the reconciliation redesign work at all without loading bodies, or does
  it force a per-note content hash into Tier 1 — and if so, who maintains it?
