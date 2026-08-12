# Memory Footprint

> **Status: superseded (archived).** This document's central thesis — that a
> warm `Y.Doc` costs 4-7x a cold one because of an unflattened V8 rope, and
> that re-materialisation reclaims 73-76% of it — did not survive production
> measurement. `Y.encodeStateAsUpdate` flattens ropes as a side effect and the
> save path encodes constantly, so the rope never accumulates; the real ceiling
> is unmergeable **struct count**. Re-materialisation has been removed from the
> server entirely. The current model lives in
> [Monolith](../architecture/monolith.md) and
> [Warts and limits](../architecture/warts-and-limits.md).
>
> Kept because the measurement methodology below — especially the `external`
> vs `heapUsed` trap — is still correct and is recorded nowhere else.

[Monolith](../architecture/monolith.md) argues that one Y.Doc per vault is worth its scaling ceiling. This document is about where that ceiling actually is, because it is not where the storage numbers suggest.

Storage is not the binding constraint. A Durable Object gets 1 GB, and the [checkpoint/journal engine](../architecture/checkpoint-journal.md) keeps writes proportional to edits rather than to vault size. The constraint is the isolate: **128 MB of memory, holding one fully-decoded Y.Doc**. Everything below is an attempt to find out what that 128 MB actually buys.

## Cold loading is not the problem

A document loaded once from storage and then left alone is cheap, and close to linear in the text it holds:

- ~1.16 bytes per character for ASCII content
- ~2.1 bytes per character for content that is genuinely UTF-16

That is the CRDT metadata being almost free. 112 MB of text cold-loads into a 130 MiB heap — the structure costs a rounding error over the bytes themselves, and decode does not blow up on the way in.

If cold-load cost were the whole story, the monolith would comfortably hold a vault far larger than any we care about. It is not the whole story.

## Warm documents are 4-7x their own cold load

Take a server document that has been live for hours applying client updates, encode its state, and decode that state into a fresh Y.Doc. The two documents are logically identical — same content, same structure, byte-identical encoding. The warm one costs four to seven times as much memory.

The cause is not Yjs item overhead, and it is worth being blunt about that because it is the intuitive answer and it is wrong. Yjs merges adjacent inserts from the same client by concatenating their strings: `str += str`, run once per keystroke-sized update. V8 does not eagerly flatten that. It builds a cons-string — a rope — and the rope is retained, node by node, for as long as the item is. Fine-grained sequential editing runs that concatenation millions of times, and the document ends up holding a deep tree of string nodes whose flattened content would fit in a fraction of the space.

Item count stays flat while memory climbs. That is the signature.

## Two regimes, and how to tell them apart

There are exactly two ways a Y.Doc gets expensive, and they have different remedies, so diagnosing which one you are in matters more than the absolute number.

**Rope accumulation.** Sequential edits inside one note merge into a small number of large items whose strings were built by repeated concatenation. Re-materialising — encoding the document's own state and decoding it into a fresh Y.Doc — rebuilds those strings flat and recovers **73-76%** of the footprint, returning the document to its cold-load cost. That is the floor; nothing recovers more.

**Item fragmentation.** Edits that jump between notes produce items whose clocks are not consecutive, so Yjs cannot merge them at all. Struct count explodes and stays exploded. At pathological locality — switching note on every single edit — re-materialisation recovers only **33-39%**, and the remainder is not recoverable by any re-encode, because there is nothing to flatten. The items are genuinely there.

The discriminator is **bytes per struct**. High (tens of thousands) means few large items, so the memory is in the strings: rope accumulation, recoverable. Low (tens) means many tiny items: fragmentation, not recoverable. Both benchmarks print it for every scenario.

Real editing sits much closer to the first regime than the second. People write in bursts within a note; they do not alternate notes per character.

## What this looks like in production

One real vault's Durable Object, hourly peaks sampled over 48 hours, for a document whose encoded state is 3.66 MB:

| | memory |
| --- | --- |
| min | 3.3 MiB |
| median | 36.0 MiB |
| max | 64.4 MiB |

A 3.66 MB document occupying 64 MiB at peak is the 4-7x effect, in the wild, at half the isolate limit already.

Hibernation does not reclaim it. It is tempting to treat the eviction cycle as a free periodic reset that keeps warm growth bounded on its own; the 48-hour profile says otherwise. Whatever the document has accumulated, it is still carrying.

## The ceiling this implies

Working backwards from 128 MB with the observed multiplier:

- **~11 MB of vault** without re-materialisation
- **~50 MB of vault** with it

The second number is the one quoted in [Monolith](../architecture/monolith.md) as the comfortable range for the single-doc design, and it is not free — it is contingent on periodically rebuilding the document from its own encoded state. Without that step the monolith's usable ceiling is roughly a fifth of what the architecture is otherwise good for.

## A measurement trap worth writing down

Content decoded out of a Yjs update lands in V8's `external` memory, not in `heapUsed`. A large body shows up as a fraction of a MiB of `heapUsed` and several MiB of `external`.

So `heapUsed + arrayBuffers` — the obvious thing to measure, and the thing every naive harness measures — reports **near zero** for decoded content. An experiment built on it will confidently tell you that applying updates to a document costs nothing. Measure RSS.

Two related traps sit next to it: destroying a Y.Doc does not return RSS, so a before/after comparison inside one process reports the sum rather than the difference and makes re-materialisation look like a regression; and the source corpus must be released before measuring, or you are weighing it twice.

## Reproducing this

Both benchmarks run each scenario in its own child process for exactly the reasons above:

- [`scripts/bench-memory.mjs`](../../scripts/bench-memory.mjs) — what a given amount of markdown costs, and which of the two regimes the cost is in. Prints `bytesPerStruct` and `itemsPerKB` per scenario.
- [`scripts/bench-warm-memory.mjs`](../../scripts/bench-warm-memory.mjs) — what a warm server document accumulates over a stream of client updates, and how much of that re-materialisation gets back, swept across edit locality.

If you are about to argue that the monolith can or cannot hold some vault size, run these first. Every number in this document came out of them or out of production telemetry, and none of it was obvious in advance.
