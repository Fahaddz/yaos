# Server acknowledgement design (FU-8)

> **Status: IMPLEMENTED — baseline and post-apply server echoes are wired, and the
> receipt is gated on the server's durable persist counter.**
> Protocol spike findings: `docs/archive/server-ack-spike.md`.
> Wire protocol uses `__YPS:` JSON channel (not a new binary message type).
> A confirmed receipt means the server completed a write of this device's state to
> storage. It does NOT prove another device received or applied that state. Against a
> server that predates the durability marker the receipt falls back to the older
> state-vector echo and keeps that server's weaker in-memory meaning — see
> "From state-vector gating to persist-counter gating".
>
> This is a living design/implementation note. The main remaining open thread is
> echo-cost measurement and possible batching, not the receipt mechanism or its label.

## The problem

Historically, `UpdateTracker` recorded `lastLocalUpdateWhileConnectedAt` — the last time a local
Y.Doc update occurred while the WebSocket was open. This is the strongest claim the
client could make without a server-side signal. FU-8 adds a stronger server-receipt
signal — a durable-write receipt — but the older timestamp still does NOT mean:

- the update was put on the wire
- the server received the update
- the server applied the update to the room Y.Doc
- the update was written to the journal or checkpoint

The UI must continue to label this as "last local update while connected"; do not
retrofit it into a delivery claim. FU-8 diagnostics now expose server receipt state
separately. Pending local update **count** remains unknown because the tracker uses
latest-state semantics, not a queue.
The gap: a user with poor connectivity can sit with stale data and no indication
that their writes haven't landed.

---

## What "acked" means — the options

There are five distinct levels. Each is cheaper and weaker than the next:

| Level | Meaning | Evidence |
|-------|---------|----------|
| 0 | Transport open at write time | Current — `lastLocalUpdateWhileConnectedAt` |
| 1 | Frame sent | WebSocket `send()` returned without error |
| 2 | Server received frame | Server echoes a receipt to the sending client |
| 3 | Server applied | Server applied the update to the room Y.Doc in memory |
| 4 | Server persisted | Update is in the journal or checkpoint (survives server restart) |

Level 0 and Level 4 are what ship today: a candidate is confirmed only after the
server's persist counter advances, which happens only when a write completes. Level 3
survives as the fallback against servers that predate the durability marker. Levels 1
and 2 are not exposed as separate product claims.

The analysis in the rest of this section and in "Design options for Level 3" is the
original period record. It recommended Level 3 and Option A, and Option A is what
shipped first. Read it as what was decided at the time, not as current behaviour; the
move to a durable gate is documented in "From state-vector gating to persist-counter
gating".

**Recommendation: target Level 3 (server applied).**

Level 1 (frame sent) is trivially achievable client-side but gives false confidence
under a broken server. Level 2 (server received frame) is slightly stronger but still
doesn't prove the update merged cleanly. Level 3 (server applied) is the first
level where a client can reasonably say "the server's Y.Doc has my update." Level 4
(persisted) is stronger but requires the server to flush before echoing, which adds
latency and complexity (the server already journals asynchronously).

Level 3 is also what y-partyserver's awareness mechanism is close to — a state
vector echo would prove the server's Y.Doc includes the client's ops.

---

## Design options for Level 3

### Option A: state vector echo

The server, after applying a client's Y.js update, encodes its current state vector
and sends it back over the WebSocket as a control message:

```
server → client: { type: "yaos/sv-echo", schema: 1, sv: <base64 Uint8Array> }
```

The client decodes the echo and checks whether its **last unconfirmed local candidate
state vector** is `<=` the echoed vector. If yes, the client's local state is
included in the server's Y.Doc.

**Pros:** Piggybacks on existing Y.js semantics. State vector comparison is cheap.
Echoes are compressible: a single echo can confirm all pending candidate state for
the **receiving client**, regardless of how many local updates contributed to it.
Ack knowledge is recoverable after reconnect — the server emits a fresh echo from
the current room doc, and the client compares it against its persisted unconfirmed
candidate.

**Cons:** Requires a server-side custom-message echo path. The server must encode
the state vector on each baseline and update-bearing sync frame. State vector byte
size grows with the number of distinct Yjs client IDs in the document — this must
be measured before assuming it is cheap at scale.

### Option B: monotonic per-room update counter

The server increments a room-level integer counter every time it applies an update.
It echoes the counter to all connected clients:

```
server → client: { type: "ack", seq: 42 }
```

The client tracks which `seq` it last received and which `seq` was current when each
local update was sent.

**Pros:** Simple integer comparison. Easy to surface in the UI ("update #42 acked").
Easy to persist (one integer in room metadata).

**Cons:** Doesn't directly prove which Y.js operations are included — a client that
reconnects after a gap needs to re-derive "is my state included in seq N?" by
comparing state vectors anyway. The counter is more of a heartbeat signal than a
precise ack.

### Option C: per-client update receipt

After the server applies a Y.js update from client X, it sends a receipt message
back to client X (and only X):

```
server → sender: { type: "applied", clientId: "...", clock: N }
```

where `clock` is the sender's Y.js client ID clock at the time of the update.

**Pros:** Most precise — directly maps to the Y.js update that was applied.
**Cons:** Requires tracking which WebSocket connection sent which Y.js update.
y-partyserver's current message handling doesn't expose per-sender metadata easily.

---

## Recommended approach: Option A (state vector echo)

State vector echo is the most natural fit for Y.js semantics:

1. The server already has the room Y.Doc.
2. After applying any update, `Y.encodeStateVector(doc)` gives the current server
   clock.
3. The client already knows how to decode and compare state vectors (it does this
   for sync protocol step 1).
4. Comparing the echoed SV against the client's local candidate SV is O(n) where
   n is the number of distinct Y.js client IDs — typically small, but must be
   measured in real vaults (see spike tasks).
5. A single echo can confirm all pending candidate state for the **receiving client**,
   regardless of how many local updates contributed to the candidate.

---

## Why a state-vector receipt was unsound (the motivating bug)

A state vector maps Yjs client ID to highest clock: it describes **inserts only**.
Deletions live in the delete set, which a state vector does not describe at all. Two
documents differing by an arbitrary number of deletions can have byte-identical state
vectors.

The persistence layer used to skip a save when the state vector was unchanged. Deletion-
only changes therefore hit a save that reported success and wrote nothing. Observed in
production: a client reaped 40 tombstoned bodies, the server logged
`save.skipped_equal_sv`, and the room reverted to 178 texts while the client held 138 —
both sides reporting themselves synced.

The save gate is now the update-driven `dirty` flag in `PersistenceCoordinator`, never a
state-vector comparison. The same reasoning disqualifies the state vector as the basis
for a *receipt*: it cannot represent the class of change most likely to be lost, so an
echo of it confirms a deletion that may never have been stored. A receipt built on it is
strongest exactly where it is least trustworthy.

---

## From state-vector gating to persist-counter gating

**What shipped first** (Option A, above): the server echoed its state vector, and the
client confirmed its pending candidate once the echoed vector covered the candidate's
clocks. That proved an in-memory apply and nothing more.

**What ships now**: the receipt is gated on a durable persist counter.

- `PersistenceCoordinator.health.persistedGeneration` is a monotonic count of successful
  persists by that coordinator instance. It advances **only** after a save completes
  successfully. A **skipped** save does not advance it — `executeSave()` returns early
  when the document is not dirty and when the computed delta is empty. A **failed** save
  does not advance it either; the failure path marks health `degraded` and re-arms
  `dirty` so the next save retries.
- `PersistenceCoordinator.health.generationEpoch` is a value unique to the coordinator
  instance, generated in its constructor — in practice, unique per Durable Object
  instance.
- The echo carries both alongside the state vector, as `gen` and `genEpoch`
  (`server/src/svEcho.ts`).
- The client records the generation in force when it captures a candidate
  (`generationAtCapture`), and confirms that candidate only when a later echo reports a
  generation **strictly greater** than that baseline (`src/sync/serverAckTracker.ts`).

Because the counter advances only on a completed write, a receipt now means "your state
was written to storage". This is a strengthening of the guarantee, not a relabelling of
it: the previous mechanism could confirm state the server had merged in memory and never
saved.

### The epoch and the re-baselining rule

The counter lives in memory, so a Durable Object restart resets it. A client holding
generation 40 would otherwise wait forever for 41. `genEpoch` makes a restart
distinguishable from progress: when the reported epoch differs from the one the client
last saw, the client re-baselines its capture generation to the newly reported value.

On re-baseline the client deliberately leaves any pending candidate **unconfirmed**. The
new instance loaded the document from storage and may not hold an unsaved change;
claiming otherwise would be a lie. Failing closed here costs a redundant "not saved yet"
state and one more echo; failing open costs the user the change with a green light next
to it.

The same rule applies after a client restart, where `generationAtCapture` starts null:
the first marker-bearing echo only establishes the baseline, and confirmation waits for a
later echo.

### The retained state-vector fallback: two coexisting guarantee levels

The state-vector comparison remains in place as the fallback for servers that predate the
durability marker. When an echo arrives without a usable `gen`/`genEpoch` pair, the client
falls back to `isStateVectorGe(serverSv, candidateSv)`. That preserves those servers'
existing behaviour rather than withdrawing receipts from them — a client talking to an old
server keeps the weaker receipt it already had instead of losing status entirely.

Two guarantee levels therefore coexist, distinguished by whether the marker is present:

| Marker | Confirmation gate | What a confirmed receipt proves |
|--------|-------------------|---------------------------------|
| present | echoed `gen` > generation at candidate capture, same epoch | the server completed a write of your state to storage |
| absent | echoed state vector covers the candidate state vector | the server applied your state to the room Y.Doc in memory |

`ServerAckTracker.receiptGuaranteeIsDurable` reports which is in force — true once a
durability marker has been seen. UI copy must be driven from that flag, never from an
assumption that the stronger guarantee applies.

### The schema was deliberately not bumped

`gen`, `genEpoch`, and `degraded` are additive optional fields on the existing
`schema: 1` payload. The client rejects an echo on strict schema inequality
(`p.schema !== SV_ECHO_SCHEMA` in `src/sync/svEchoMessage.ts`), so bumping the schema
would make every already-deployed client discard every echo and lose the receipts it
currently has. Extending the payload instead costs nothing: old clients ignore unknown
fields. A partial or malformed marker is treated as absent, not as a parse failure.

### `degraded`: persistence health on the same channel

The echo also carries an optional `degraded` boolean, emitted only when the room's
persistence health is degraded. It rides this channel because the echo is the only
message the client already receives on connect and on every update-bearing frame.

Without it, a server that cannot store writes is invisible: the socket stays healthy
while saves fail, so the client has no signal short of polling the debug endpoint.
`ServerAckTracker.serverPersistenceDegraded` exposes it so the UI can say the server is
not saving. An echo without a marker leaves the last known value alone rather than
claiming health, since such a server cannot report it.

**Caveat**: `kv-fallback` storage mode suppresses SV echoes entirely
(`server/src/server.ts`), because echoing in that mode would advertise durability the
store cannot deliver. That state therefore presents as **silence** — no echoes, no
receipts, no `degraded` flag — not as a raised flag. Absence of echoes must never be read
as health.

---

## Wire protocol (implementation sketch)

**Spike finding**: binary unknown message types are silently dropped by the
y-partyserver client provider (`console.error("Unable to compute message")`; no
event emitted). A new binary message type is therefore not viable without patching
or wrapping the provider.

**Decision**: use y-partyserver's existing `__YPS:` string custom-message channel.

This section records the intended implementation shape. The working code is now in:

- `server/src/syncMessageClassifier.ts` — update-bearing Yjs sync frame classifier
- `server/src/svEcho.ts` — `__YPS:` SV echo payload and send helper
- `server/src/server.ts` — baseline echo in `onConnect()`, post-apply echo in `handleMessage()`
- `server/src/persistenceCoordinator.ts` — `persistedGeneration`, `generationEpoch`, health status
- `src/sync/svEchoMessage.ts` — client parser, optional durability marker, failure reasons, counters
- `src/sync/serverAckTracker.ts` — generation truth gate, with state-vector dominance as fallback
- `src/sync/vaultSync.ts` — client custom-message handler and receipt diagnostics

See `docs/archive/server-ack-spike.md` for the protocol findings and caveats
(base64 chunking, namespaced type field, `trySendSvEcho` wrapper,
`parseSvEchoMessage` parser).

### Server → client

```ts
// In VaultSyncServer — sendSvEcho helper (sketch — see spike doc for caveats):
private sendSvEcho(connection: Connection): void {
    // Emitted after the in-memory Y.Doc apply. The emission point is NOT what makes the
    // receipt durable — the marker in the payload is. The client confirms only on an
    // echo whose generation exceeds its capture baseline, i.e. one sent after a save
    // completed.
    const sv = Y.encodeStateVector(this.document);
    const health = this.getPersistenceCoordinator().health;
    // Namespaced, schema-versioned payload; chunked base64 for large SVs.
    // gen/genEpoch/degraded are additive and optional — the schema is NOT bumped.
    this.sendCustomMessage(connection, JSON.stringify({
        type: "yaos/sv-echo", schema: 1, sv: toBase64(sv),
        gen: health.persistedGeneration, genEpoch: health.generationEpoch,
        ...(health.status === "degraded" ? { degraded: true } : {}),
    }));
}

// On baseline connect (override onConnect):
override onConnect(conn: Connection, ctx: ConnectionContext): void {
    super.onConnect(conn, ctx);   // sends SyncStep1 + awareness
    this.sendSvEcho(conn);        // baseline echo: current server SV
}

// On client update applied (override handleMessage):
override handleMessage(connection: Connection, message: WSMessage): void {
    let shouldEcho = false;
    if (!(typeof message === "string")) {
        try {
            const array = message instanceof Uint8Array
                ? message : new Uint8Array(message as ArrayBuffer);
            const d = decoding.createDecoder(array);
            const outerType = decoding.readVarUint(d);
            if (outerType === 0 /* messageSync */) {
                const innerType = decoding.readVarUint(d);
                // inner type 0 = SyncStep1 (client sends state vector, no update applied)
                // inner type 1 = SyncStep2 (client's missing ops, update applied)
                // inner type 2 = Update (live update, applied)
                shouldEcho = innerType === 1 || innerType === 2;
            }
        } catch { /* malformed frame */ }
    }
    super.handleMessage(connection, message);
    if (shouldEcho) this.sendSvEcho(connection);
}
```

`sendCustomMessage()` is already on `YServer` (typed in `.d.ts:33`). No new imports
needed beyond `lib0/decoding` for the inner-type peek.

### Client → UpdateTracker

```ts
// In VaultSync — wire up after provider is created (sketch — see spike doc for caveats):
// Register this handler BEFORE any provider message processing can fire.
provider.on("custom-message", (msg: string) => {
    // Pure parser — validates type, schema, and size, and returns the optional
    // durability marker. A partial or malformed marker is reported as absent.
    const result = parseSvEchoMessageDetailed(msg);
    if (result.kind === "valid_sv_echo") {
        this.updateTracker.recordServerSvEcho(result.sv, result.durability);
    }
});
```

`provider.on("custom-message", handler)` is a documented event on the y-partyserver
provider (fires when server sends `__YPS:` prefixed string). No provider patching.

---

## Candidate SV lifecycle

This section is the core of the design. Get it wrong and the ack is a lie.

### What a "local candidate" is

A local candidate SV represents unconfirmed local CRDT state produced by this client
— any non-provider, non-IDB-persistence update. This includes editor edits, disk
imports, snapshot restores, repair writes, and maintenance updates. It is **not**
necessarily a user edit (see FU-12 for that distinction). Use "Pending local state"
in UI copy, not "Pending local edits."

**Origin predicate**: Do not silently reuse the disk-mirror `isLocalOrigin()`
predicate for candidate tracking. The disk-mirror predicate gates writeback
suppression; the ack predicate gates candidate capture. They classify the same
origins today, but define a separate `isAckTrackedLocalOrigin(origin, provider,
persistence)` so that future changes to either predicate cannot silently break the
other.

**Latest-state semantics**: The tracker maintains one candidate SV, not a queue.
When multiple local updates occur before any echo, the candidate is always the SV
snapshot after the most recent local update. A dominating echo confirms the
candidate, which implicitly confirms all prior local updates the candidate subsumes.
If an echo dominates an older SV but not the current candidate, status remains
unconfirmed. Do not introduce a pending count — this is latest-local-state
confirmation, not per-update delivery tracking.

### Lifecycle rules

```ts
// On any isAckTrackedLocalOrigin Y.Doc update, connected or offline:
onLocalUpdate(): void {
    this._lastUnconfirmedCandidateSv = Y.encodeStateVector(this.doc); // captured after transaction
    this._serverAppliedLocalState = false;
    // Baseline for the durability gate: this candidate is confirmed only once an echo
    // reports a persist generation strictly beyond this value. Null until the first
    // marker-bearing echo arrives, which then becomes the baseline.
    this._generationAtCapture = this._lastSeenServerGeneration;
    this._lastLocalUpdateAt = Date.now();
    if (this._connected) {
        this._lastLocalUpdateWhileConnectedAt = Date.now();
    }
    this._persistCandidateState(); // persist immediately after capture
}

// On disconnect:
onDisconnect(): void {
    this._connectionGeneration++;
    this._connected = false;
    // Do NOT clear _lastUnconfirmedCandidateSv.
    // Do NOT reset _serverAppliedLocalState if already true.
    // Persisted state survives reconnect and plugin restart.
}

// On reconnect (provider reconnected):
onReconnect(): void {
    this._connected = true;
    // Candidate is retained from memory (or was restored from persistence on startup).
    // Ack state updates when the server echo arrives after sync exchange.
}

// On server SV echo:
recordServerSvEcho(serverSv: Uint8Array, durability: SvEchoDurability | null): void {
    this._lastServerReceiptEchoAt = Date.now();
    // An absent marker means a server too old to report health. Keep the last known
    // value rather than claiming healthy.
    if (durability !== null) this._serverPersistenceDegraded = durability.degraded === true;

    // A restart resets the counter, so re-baseline on epoch change instead of waiting
    // forever for a generation the new instance will never reach.
    const epochChanged = durability !== null
        && this._lastServerGenerationEpoch !== null
        && durability.epoch !== this._lastServerGenerationEpoch;
    if (epochChanged) this._generationAtCapture = durability.generation;
    if (durability !== null) {
        this._lastServerGenerationEpoch = durability.epoch;
        this._lastSeenServerGeneration = durability.generation;
    }

    if (this._lastUnconfirmedCandidateSv !== null) {
        this._serverAppliedLocalState = durability !== null
            // Durable gate: a write completed after this candidate was captured. An
            // epoch change never confirms — the new instance may not hold the change.
            ? !epochChanged
                && this._generationAtCapture !== null
                && durability.generation > this._generationAtCapture
            // Fallback for servers predating the marker: in-memory apply only.
            : isStateVectorGe(serverSv, this._lastUnconfirmedCandidateSv);
        if (durability !== null && this._generationAtCapture === null) {
            this._generationAtCapture = durability.generation; // first baseline
        }
    }
    // If no candidate: update lastServerReceiptEchoAt but leave serverAppliedLocalState null.
    this._persistCandidateState();
}

// On startup, after IDB has loaded CRDT state:
onStartup(): void {
    const stored = this._loadPersistedCandidateState();
    if (!stored || !stored.candidateSv) return;

    this._lastUnconfirmedCandidateSv = stored.candidateSv;

    // Do NOT restore serverAppliedLocalState = true as active truth.
    // A persisted `true` means "the server had written it at that moment" — not "the
    // server still has it": server reset and room reclaim are undetectable from client
    // state alone, and the generation baseline the confirmation was judged against does
    // not survive restart. Wait for a fresh echo to revalidate.
    this._serverAppliedLocalState = null;
    this._lastKnownServerReceiptEchoAt = stored.lastKnownServerReceiptEchoAt ?? null;

    // Validate candidate against the current local doc state (see below).
    this._validateCandidateAgainstDoc();
}

// Validates persisted candidate against current local doc state after IDB loads.
// Prevents stale candidate persistence from producing false status.
//
// State-vector dominance rules (four exclusive cases):
//   "candidate ahead of doc":  candidate has clocks local doc doesn't. Stale/corrupt → discard.
//   "doc ahead of candidate":  local doc has advanced past candidate → replace candidate.
//   "equal":                   identical SVs → candidate is valid, wait for fresh echo.
//   "incomparable":            each has clocks the other lacks (e.g. device used as both
//                              sender and receiver of a merge) → conservative discard.
//
// Rule: never emerge from this function with serverAppliedLocalState = true.
private _validateCandidateAgainstDoc(): void {
    if (!this._lastUnconfirmedCandidateSv) return;
    const currentSv = Y.encodeStateVector(this.doc);
    const docDominatesCandidate = isStateVectorGe(currentSv, this._lastUnconfirmedCandidateSv);
    const candidateDominatesDoc = isStateVectorGe(this._lastUnconfirmedCandidateSv, currentSv);

    if (docDominatesCandidate && candidateDominatesDoc) {
        // Equal — candidate is valid. serverAppliedLocalState stays null until fresh echo.
        return;
    }

    if (docDominatesCandidate && !candidateDominatesDoc) {
        // Local doc has advanced past the candidate (e.g. IDB crash gap, merge).
        // Replace candidate with the current local doc SV and mark unconfirmed.
        // arrived while offline or was already confirmed. That is acceptable because the
        // truth gate is the server's persist generation, not the candidate's contents: a
        // candidate carrying extra remote state is still confirmed by the next echo that
        // reports a completed write. It will not produce false `true`.
        this._lastUnconfirmedCandidateSv = currentSv;
        this._serverAppliedLocalState = false;
        this._persistCandidateState();
        return;
    }

    // candidateAheadOfDoc (doc doesn't dominate) OR incomparable (neither dominates):
    // Candidate claims clocks the local doc doesn't have, or SVs diverge.
    // Both cases: discard candidate, fail closed.
    this._lastUnconfirmedCandidateSv = null;
    this._serverAppliedLocalState = null;
    this._persistCandidateState();
}
```

```ts
function isStateVectorGe(a: Uint8Array, b: Uint8Array): boolean {
    const svA = Y.decodeStateVector(a);
    const svB = Y.decodeStateVector(b);
    for (const [clientId, clock] of svB) {
        if ((svA.get(clientId) ?? 0) < clock) return false;
    }
    return true;
}
```

### Why "do not clear candidate on disconnect"

The critical user workflow:

```
Device A edits note while offline.
onLocalUpdate() captures candidate SV. serverAppliedLocalState = false. Candidate persisted.
Socket is closed (or was never open). Candidate is retained in memory and persistence.
Device A reconnects.
Yjs sync sends the offline edit to the server.
Server applies the edit and emits a post-apply SV echo.
recordServerSvEcho() compares echo against retained candidate.
serverAppliedLocalState = true. Persisted.
```

If the candidate were cleared on disconnect, step 7 would find no candidate, the
echo would be ignored, and the user's offline edit would never be confirmed. That is
the exact case this system exists to solve.

### Persisted candidate state

The tracker must persist enough state to survive plugin restart. The persisted
format:

```ts
type PersistedCandidateState = {
    schema: 1;
    // Scope fields — every field must match current context on load.
    // Any mismatch → discard entirely, fail closed to null.
    vaultIdHash: string;       // SHA-256 of vaultId, hex-encoded (not raw — avoid leaking IDs in storage)
    serverHostHash: string;    // SHA-256 of the server host URL, hex-encoded
    localDeviceId: string;     // stable per-install UUID (see below — NOT deviceName)
    roomName: string;          // DO room name for this vault; changes on server reset/reclaim
    docSchemaVersion: number;  // CRDT doc schema version at time of capture
    // Metadata (not used for scope invalidation — for diagnostics and migration only)
    pluginVersion: string;     // semver at time of capture; recorded, not used for invalidation
    ackStoreVersion: number;   // increment when persisted format changes to allow future migration
    // Candidate fields
    candidateSvBase64: string | null;    // base64-encoded Uint8Array
    candidateCapturedAt: number | null;  // ms timestamp
    // Historical-only: persisted `serverAppliedLocalState=true` is NOT restored as
    // active truth after restart. It records a completed server write at that moment,
    // not the current room's state, and the generation baseline it was judged against
    // is gone. Use `lastKnownServerReceiptEchoAt` only for "last known" UI.
    lastKnownServerReceiptEchoAt: number | null;
};
```

**`localDeviceId`**: A stable UUID generated once per local plugin install and stored
in local-only storage (never synced). This is NOT `settings.deviceName` — device name
is user-facing, mutable, and non-unique. Multiple devices can share a name; one device
can rename. Use `crypto.randomUUID()` on first run and persist it to local-only
IndexedDB or `localStorage`. `deviceName` is for display only.

**`roomName` and server reset**: `roomName` is the Durable Object room/stub name that
scopes this vault's CRDT state. If the server is reset or the vault is reclaimed, the
room name or room identity changes, making the old candidate state meaningless. If no
server generation/version field is exposed by the server in Phase A, the design must
explicitly state:

```text
Server reset and vault reclaim cannot be detected from client-side state alone in Phase A.
If a user reports stale ack status after a server migration or reset, the fix is to clear
local candidate state (either automatically on scope mismatch, or via a diagnostics action).
```

Do not claim "covers server reset" unless `roomName` or `serverGeneration` actually
changes on reset and the stored value is compared on load.

**Storage location**: a dedicated local-only IndexedDB store. Do NOT use Obsidian's
`plugin.saveData()` / `data.json` — that file is inside `.obsidian/plugins/yaos/` and
may be synced by users who sync their `.obsidian` config. Candidate state is per-device
runtime state that must not cross-contaminate across devices via `.obsidian` sync.

Store key pattern:

```text
yaos-ack-v1:${serverHostHash}:${vaultIdHash}:${localDeviceId}
```

Use hashed identifiers in the key (not raw URLs or vault IDs) to avoid storing
sensitive values in key names. The record payload already carries the raw values for
scope comparison.

**On startup after IDB ready**: Load persisted state. Compare all scope fields against
current values. If any field mismatches (different vault, server, room name, device, or
doc schema version), discard the stored state entirely and fail closed to
`serverAppliedLocalState = null`. If scope matches, load `candidateSvBase64` and
`lastKnownServerReceiptEchoAt`. Do NOT restore `serverAppliedLocalState = true` as active
truth — call `_validateCandidateAgainstDoc()` and wait for a fresh echo to revalidate.

**On persistence failure**: If a write throws, increment `candidatePersistenceFailureCount`,
set `candidatePersistenceHealthy = false`, log via diagnostics trace (not `console.error`),
and continue with in-memory state only. The current session can still track ack status
in memory; restart survival becomes unavailable until the store is healthy again. Do not
surface a user-visible error for transient persistence failures. **On the next successful
candidate-state write, reset `candidatePersistenceHealthy = true` and stop logging failures.**
Expose `candidatePersistenceFailureCount` in diagnostics.

**On server reset / room reclaim (until `serverGeneration` exists)**: Server reset is
undetectable from client state alone if `roomName` does not change. Until Phase A has a
server generation discriminator, the fix for a user with stale receipt status after a
reset is a manual action. Expose a diagnostics command: **"Clear local server-receipt
state"** that discards the persisted candidate and resets `serverAppliedLocalState` to
`null`. Do not silently auto-clear on reset without a detectable signal.

**On local update**: Capture candidate, set `serverAppliedLocalState = false`, persist.

**On server echo confirming candidate**: Set `serverAppliedLocalState = true`, update
`lastKnownServerReceiptEchoAt`, persist.

**On new local update after confirmed state**: Replace candidate, reset to
`serverAppliedLocalState = false`, persist.

---

## Echo timing — when the server must emit

Two distinct echo events are required. One alone is not sufficient.

### Echo 1: Post-apply echo (the carrier of the durability marker)

The echo is sent after the server processes a Yjs sync message with inner type 1
(SyncStep2) or 2 (Update). It is named "post-apply" because the normal case is that
`Y.applyUpdate()` ran and the server's Y.Doc now includes the client's ops.

**A post-apply echo does not itself confirm the candidate.** It reports the persist
generation as of that moment, which is the generation *before* the just-applied update
has been saved. Confirmation arrives on a later echo — the next post-apply echo, or the
baseline echo on the next connect — once a save has completed and the generation has
advanced past the client's capture baseline. Confirmation therefore trails the write by
one save cycle (`onSave` is debounced by the framework) plus one echo. That latency is
the price of the receipt meaning "stored" rather than "in memory".

An echo also fires for duplicate or no-op sync frames. That is intentional: every echo is
a fresh report of server state, and the client's gate — generation, or state-vector
dominance against a server predating the marker — decides whether it confirms anything.

This is the mechanism that eventually confirms offline edits delivered after reconnect.
The baseline echo alone is not sufficient: it fires before the sync exchange completes,
so it can only report a generation predating those edits.

### Echo 2: Baseline echo on room load / client connect

```ts
// After the room document is loaded and the connection is admitted.
// Exact hook point within the join flow must be confirmed by the spike.
const sv = Y.encodeStateVector(this.document);
const encoder = encoding.createEncoder();
encoding.writeVarUint(encoder, messageSvEcho);
encoding.writeVarUint8Array(encoder, sv);
newClient.send(encoding.toUint8Array(encoder));  // newly connected client only
```

This is a **baseline status signal**, not a confirmation signal. It lets the client
immediately evaluate whether its persisted candidate was already known to the server
— for example, if the exact same Yjs operations already reached the server via
another connection earlier. The baseline echo will legitimately set
`serverAppliedLocalState = false` when the client carries offline edits the server
has not yet received. That is correct and expected.

The baseline echo occurs before the client's missing offline updates are delivered.
That is fine — the post-apply echo from step Echo 1 (after the server applies those
updates) is what provides confirmation.

### Ordering for a reconnecting client with offline edits

```text
Client reconnects with offline edits.
Server emits baseline echo.            ← server does not have the offline edits yet
  → client re-baselines if the epoch changed; candidate stays unconfirmed
Client sends missing updates (Yjs sync exchange).
Server applies missing updates.
Server emits post-apply echo.          ← generation not advanced yet; still unconfirmed
Server's debounced save completes.     ← persistedGeneration++
Next echo (post-apply or baseline).    ← generation now beyond the capture baseline
  → client sees serverAppliedLocalState = true (correct: the edits are in storage)
```

Every state before the last is correct and expected. The transition false → true is the
signal, and it now waits for a completed write rather than for an in-memory apply.

### Echo failure / connection close

WebSocket delivery is ordered and reliable while the connection is alive. If the
connection closes before the post-apply echo is delivered, the candidate remains
unconfirmed in both memory and persistence. On reconnect, the baseline echo and/or
post-apply echo re-evaluate the retained candidate. No retry protocol is needed.

---

## State-vector echo cost

State vector size grows with the number of distinct Yjs client IDs that have ever
written to the document. In YAOS:

- Each device session may generate a new Yjs client ID (depending on IDB persistence).
- Repair, migration, and snapshot operations add their own client IDs.
- Long-lived vaults may accumulate many historical client IDs.

The design proposes emitting a state vector after every incoming client update.
Under active typing, this may be one echo per small CRDT operation. **Before
finalizing "immediate echo" as the default:**

```text
Measure or bound:
- Typical SV byte size in real YAOS vaults
- Worst observed SV byte size
- Number of distinct Yjs client IDs in real vaults
- Echo frequency under normal typing
- Cloudflare egress and CPU cost per echo
```

If echo volume is high, batch per sender at 100–250 ms. A short delay is invisible
to users and much cheaper under typing bursts. The implementation must expose counters
for echo count and average/max SV size to evaluate this post-deployment.

---

## Naming

Use these names consistently. **Do not use `serverAcked` or `lastServerAckAt`
anywhere in code, comments, or tests.**

```ts
// UpdateTracker fields:
lastUnconfirmedCandidateSv: Uint8Array | null  // SV snapshot at last unconfirmed local write
generationAtCapture: number | null              // persist generation in force when the candidate was captured
lastSeenServerGeneration: number | null         // most recent generation reported by an echo
lastServerGenerationEpoch: string | null        // server instance the generation belongs to
serverAppliedLocalState: boolean | null         // null = no candidate loaded this session
lastServerReceiptEchoAt: number | null              // timestamp of last SV echo THIS session (resets to null on restart)
lastKnownServerReceiptEchoAt: number | null         // persisted historical timestamp; survives restart; "last known"

// SyncFacts (exposed to UI):
serverAppliedLocalState: boolean | null
lastServerReceiptEchoAt: number | null              // present if a fresh echo arrived this session
lastKnownServerReceiptEchoAt: number | null         // present if historical persisted timestamp exists
receiptGuaranteeIsDurable: boolean                  // true once a durability marker has been seen
serverPersistenceDegraded: boolean                  // server reported it cannot store writes
```

These two timestamps have different semantics and must not be merged:

- `lastServerReceiptEchoAt`: set when a fresh SV echo arrives from the server this session.
  Resets to `null` on plugin restart. Represents current-session confirmation.
- `lastKnownServerReceiptEchoAt`: loaded from persisted state on startup. Represents the
  historical "last time we knew the server had it." Does NOT imply current server state.

The UI must use `lastServerReceiptEchoAt` when the session is active and a fresh echo
has arrived. It must fall back to `lastKnownServerReceiptEchoAt` only for the "last known"
display after restart — never as a substitute for current-session confirmation.

The internal name `serverAppliedLocalState` is retained because it is the shipped field
name across the tracker, `SyncFacts`, diagnostics, and the persisted store. It now reads
as an understatement: when `receiptGuaranteeIsDurable` is true, the field means the server
completed a write of this device's latest local state. Against a server predating the
durability marker it keeps its original meaning of an in-memory apply. Do not rename it
without migrating the persisted store, and do not let UI copy inherit the older, weaker
meaning.

Any expanded status or tooltip must state the guarantee actually in force. The shipped
strings live in `src/status/statusBarController.ts` as `SERVER_RECEIPT_STATUS_TITLE`
(durability marker present):

```
Server receipt means this device's latest local CRDT state was written to the server's
storage. It does not prove that another device received the change.
```

and `SERVER_RECEIPT_STATUS_TITLE_LEGACY`, used when `receiptGuaranteeIsDurable` is false,
where the state-vector fallback proves only an in-memory apply:

```
Server receipt means this device's latest local CRDT state was applied to the server
Y.Doc in memory. This server does not report storage confirmation, so the receipt does
not prove durable storage or that another device received the change.
```

Keep them as two separate strings. Softening the durable one into a hedge would describe
the common case as though it were still the weak case, which is the mistake this replaces.

### UI combination rule

`serverAppliedLocalState` must always be combined with connection state and timestamp.
A bare boolean is not enough:

```ts
// Do not display serverAppliedLocalState in isolation. Always combine:
{ serverAppliedLocalState, connected, lastServerReceiptEchoAt, lastKnownServerReceiptEchoAt }
```

Example copy:

| `serverAppliedLocalState` | `connected` | `lastServerReceiptEchoAt` | Display (shipped strings) |
|--------------------------|-------------|----------------------|---------|
| `null` | any | — | "Receipt: not tracked yet" |
| `false` | `true` | — | "Receipt: local state not yet received by server" |
| `false` | `false` | — | "Receipt: offline — local state not yet received by server" |
| `true` | `true` | present | durable: "Receipt: server saved latest local state" / fallback: "Receipt: server received latest local state" |
| `true` | `false` | present | durable: "Receipt: offline — server saved at [time]" / fallback: "Receipt: offline — server receipt at [time]" (use `lastServerReceiptEchoAt`) |
| `null` | any | — (only `lastKnownServerReceiptEchoAt`) | "Receipt: last known server receipt at [time] — checking…" |

The unconfirmed rows say "not yet received" rather than "not yet saved": before a receipt
arrives the client cannot tell which of the two the server failed to do, and the weaker
wording is the one that is always true.

`serverPersistenceDegraded` is a separate segment ("Server not saving"), ranked ahead of
the receipt and shown even while connected — a healthy socket is exactly what makes that
failure invisible. Echo silence carries no segment at all, so it cannot be read as health.

The `null` row means no candidate has been captured in this session or loaded from
persistence — it does NOT necessarily mean there are pending updates.

**After plugin restart**: `serverAppliedLocalState` is always `null` until a fresh echo
arrives (persisted `true` is never restored as active truth). If `lastKnownServerReceiptEchoAt`
is present from persistence, use the bottom row: "Last known server receipt: [time]; checking…".
Never show a saved-or-received status based on persisted state alone. After restart the
generation baseline is gone too, so the first marker-bearing echo only establishes it and
confirmation needs a later echo reporting a completed write. Once that arrives,
`serverAppliedLocalState` becomes `true` and `lastServerReceiptEchoAt` is set — then the
normal `true` rows apply.

Do not show a naked status when the transport is currently offline. The guarantee is
about the last echo that arrived, not about now: the server had saved the state that
reached it by then, and anything written since is unconfirmed. Always pair the status
with its timestamp.

**Do not** use `serverAcked` or `serverReceivedLocalState` as internal names, and do not
use "synced" or "confirmed" in copy — neither is proven by a receipt. "Saved" is now
correct copy, but only while `receiptGuaranteeIsDurable` is true.
Do not use "Pending local edits" — maintenance writes also create candidates.

---

## Server-side implementation scope

### Phase A: sender-only echo

**Decision: echo to the sender only after applying their update. No broadcast in Phase A.**

Additionally, the server MUST emit a baseline echo to newly connected clients after
the room document is loaded and the connection is admitted.

Broadcast is deferred to Phase B if a global "all devices caught up" indicator is
ever required.

### Exact hook point

The echo is emitted **after `Y.applyUpdate()` returns successfully**, **before**
`enqueueSave()` runs. The emission point was never moved; the guarantee comes from the
durability marker in the payload, not from when the frame is sent:

```text
Receipt guarantee: the server completed a write of your state to storage.
Carried by:        gen / genEpoch, where gen advances only on a successful save.
Confirmed by:      a later echo whose gen exceeds the client's capture baseline.
NOT guaranteed:    another device has received the change.
```

Emitting after persistence instead proved unnecessary. Making the client wait for the
generation to advance yields the durable guarantee without holding an echo open across a
save, and it also credits writes flushed by a save the client did not trigger.

---

## Hibernation behaviour

Under Cloudflare DO hibernation, the in-memory Y.Doc is rebuilt from
`ChunkedDocStore` on cold start. State vectors are derived from document state — they
survive correctly.

The persist counter does NOT survive: `persistedGeneration` is in-memory and restarts at
zero, and `generationEpoch` is regenerated per coordinator instance. That is precisely
what the epoch is for — a client seeing a new epoch re-baselines and leaves any pending
candidate unconfirmed, because the rebuilt document came from storage and cannot vouch
for a change that was never saved.

**Required**: on room cold-start, after the document is loaded and the connection is
admitted, the server emits a baseline SV echo to the newly connected client.

Receipt knowledge is only partly recoverable after a cold start. The server regenerates an
echo from the current room doc, but the generation it reports belongs to a new epoch, so a
pending candidate is re-baselined and left unconfirmed until this device's state is written
again. That is the honest answer: the rebuilt document holds only what storage had. Against
a server predating the durability marker the older recovery still applies — the echoed state
vector is compared against the persisted candidate directly. The echo message itself never
needs to persist.

---

## What this does NOT solve

**"Server saved" ≠ "other devices have it"** — this is the boundary to maintain in docs
and UI labels.

A confirmed receipt means the server completed a write of this device's captured state to
storage. It does NOT mean:

- another device has received or applied the change
- the change is visible in any other client's document
- a local change made after the confirmed candidate is saved — the receipt covers the
  candidate it confirmed, nothing later

**Two guarantee levels coexist.** Against a server predating the durability marker the
receipt falls back to state-vector dominance and proves only an in-memory apply. UI copy
must follow `receiptGuaranteeIsDurable` instead of assuming the stronger claim.

**Degraded and silent servers.** `degraded` reports that the server cannot store writes.
`kv-fallback` mode emits no echoes at all, so that failure appears as an absence of
receipts rather than as a flag; absence of an echo is not evidence of health.

**Offline edits**: The candidate is persisted across disconnect and plugin restart.
After reconnect, the first echo reporting a persist generation beyond the capture
baseline confirms those offline edits, from any session in which the local update was
captured and persisted.

---

## UI label discipline

Do NOT use these labels for a confirmed receipt:
- "Synced" — implies multi-device delivery, which no receipt proves
- "Confirmed" — implies end-to-end delivery
- "Acked" — too technical and over-implies safety
- "Pending local edits" — implies user edits only; use "local state"

Use:
- "server saved" wording — accurate for a confirmed receipt while
  `receiptGuaranteeIsDurable` is true (shipped: "Receipt: server saved latest local state")
- "server received" wording — the fallback against a server predating the durability
  marker, where the receipt proves an in-memory apply only
- "Server not saving" — for `serverPersistenceDegraded`

Always combine status with connection state and timestamp. See Naming section.

"Saved" wording must never appear while `receiptGuaranteeIsDurable` is false, and must
never be stretched to mean other devices are up to date.

---

## Design decisions

These are settled. Do not relitigate them in implementation.

| Decision | Choice |
|----------|--------|
| Ack level | Durable write: gated on the server's persist generation, which advances only on a completed save. State-vector dominance is retained only as the fallback for servers predating the durability marker. |
| UI label | "Saved to server" when the durability marker is present; "Server received" against fallback servers. Never "synced", "confirmed", or "acked". |
| Echo target | Phase A: sender-only plus baseline echo on connect. No broadcast. |
| Pending representation | `boolean \| null` — not a count. Latest-state, not per-update. |
| Candidate SV | `lastUnconfirmedCandidateSv` — captured at write time, not current doc SV. |
| Disconnect behavior | Retain unconfirmed candidate across disconnect. |
| Persistence | Phase A persists candidate SV and state. App restart is covered in Phase A. |
| Scoping / invalidation | `PersistedCandidateState` includes `vaultId`, `serverHostHash`, `localDeviceId` (UUID), `roomName`, `docSchemaVersion`. Scope mismatch → discard, fail closed to null. Server reset coverage requires `roomName` to change on reset; otherwise server reset must be treated as undetectable in Phase A. |
| Internal naming | `serverAppliedLocalState` / `lastServerReceiptEchoAt`. No `serverAcked`. |
| UI combination | Always combine `serverAppliedLocalState` + `connected` + `lastServerReceiptEchoAt`. |
| Echo cost | Immediate echo Phase A; batch at 100–250 ms if measurements show overhead. |

---

## Spike findings summary

Spike complete. Full findings in `docs/archive/server-ack-spike.md`.

| Task | Status | Finding |
|------|--------|---------|
| Hook point | ✅ | Override `handleMessage()` in `VaultSyncServer`; extract `isUpdateBearingSyncMessage()`; echo after `super.handleMessage()` when inner type === 1 or === 2 |
| Sender identity | ✅ | `connection` is first arg to `handleMessage`; already passed as `transactionOrigin` to `Y.applyUpdate` |
| Message type | ✅ (moot) | No binary type needed; `__YPS:` string channel is the right transport |
| Custom message forwarding | ✅ | Binary unknown types silently dropped; `__YPS:` strings fire `provider.emit("custom-message")` |
| Baseline echo timing | ✅ | Override `onConnect()`; send after `super.onConnect()` (document loaded, SyncStep1 sent) |
| SV cost | ⚠️ deferred | No library bound found; start with immediate echo, instrument, add batching if needed |

---

## Minimum test plan

Do not write protocol code without the pure-client tests passing. Server-side tests
follow after the spike.

### `isStateVectorGe` unit tests

```text
equal vectors => true
server ahead on all shared clients => true
server missing one client from candidate => false
server has extra unrelated client that candidate lacks => true
empty server SV vs non-empty candidate => false
non-empty server SV vs empty candidate => true
multi-client candidate with one missing clock => false
candidate has client A clock 5; server has client A clock 4 => false
malformed input => fail closed (throw or false, not silent true)
candidate contains old local client ID from a prior Y.Doc session; server missing that ID => false
candidate contains old local client ID; server has it at the correct clock => true
```

### `UpdateTracker` candidate lifecycle tests (pure client — implement before spike)

```text
local update while connected: candidate captured, serverAppliedLocalState=false, persisted
local update while disconnected: candidate captured, serverAppliedLocalState=false, persisted
marker echo with gen beyond capture baseline: serverAppliedLocalState=true, persisted
marker echo with gen equal to capture baseline: serverAppliedLocalState=false
marker echo with changed epoch: baseline re-set, candidate left unconfirmed [NON-NEGOTIABLE]
first marker echo after restart: establishes baseline only, does not confirm
echo without marker, dominating candidate: serverAppliedLocalState=true (fallback path)
echo without marker, not dominating candidate: serverAppliedLocalState=false
echo without marker: receiptGuaranteeIsDurable stays false
degraded flag on echo: serverPersistenceDegraded=true; a healthy marker echo clears it
echo without marker: serverPersistenceDegraded keeps its last known value
echo with no candidate: lastServerReceiptEchoAt updated, serverAppliedLocalState stays null
disconnect: unconfirmed candidate retained in memory, serverAppliedLocalState unchanged
reconnect: server echo compared against retained candidate
offline-edit confirmed (current session): candidate survives disconnect, post-apply echo dominates => true [NON-NEGOTIABLE]
offline-edit confirmed (after restart): candidate loaded from persistence, post-apply echo dominates => true [NON-NEGOTIABLE]
confirmed candidate + disconnect + reconnect + baseline echo still dominating => remains true
new local update after confirmed state: serverAppliedLocalState=false, candidate replaced, persisted
new offline local update after confirmed state: same as above while disconnected
remote provider update alone: no candidate created, serverAppliedLocalState unchanged
IDB load alone: no candidate created (IDB replay is not an ack-tracked local update)
corrupt persisted candidate on load: fails closed to serverAppliedLocalState=null, not true
stale persisted candidate from different vaultId: discarded, fails closed to null
stale persisted candidate from different serverHostHash: discarded, fails closed to null
stale persisted candidate from different localDeviceId: discarded, fails closed to null
stale persisted candidate from different roomName: discarded, fails closed to null
stale persisted candidate from older docSchemaVersion: discarded, fails closed to null
persisted serverAppliedLocalState=true not restored after restart: active state is null, lastKnownServerReceiptEchoAt retained
candidate ahead of local doc on startup: discarded, fails closed (candidate has clocks doc doesn't)
doc ahead of candidate on startup: candidate replaced with current SV, marked false
incomparable candidate and doc on startup: discarded, fails closed (neither dominates)
equal candidate and doc on startup: candidate retained, serverAppliedLocalState=null, waits for fresh echo
persistence write failure: in-memory tracking continues; candidatePersistenceHealthy=false; restart survival unavailable
```

### Server-side protocol tests

```text
server emits SV echo to sender after successfully applying client update
server does NOT emit post-apply echo before applyUpdate succeeds
server emits baseline SV echo to newly connected client after room load
server does NOT broadcast post-apply echo to unrelated clients in Phase A
echoed SV actually dominates the just-applied document state
echo carries gen and genEpoch and keeps schema at 1
gen does not advance across a skipped save
gen does not advance across a failed save
degraded flag present only when persistence health is degraded
no echo at all in kv-fallback mode
```

Current coverage:

- `tests/server-sync-message-classifier.ts`
- `tests/server-sv-echo.ts`
- `tests/server-post-apply-wiring.ts`
- `tests/receipt-durability.ts` — generation gating, epoch re-baselining, fallback path
- `tests/status-label.ts` — durable vs fallback copy, degraded segment
- `tests/provider-manual-connect.mjs` through `npm run test:integration:worker`

### Integration test

```text
offline candidate survives disconnect; reconnect sync delivers missing update; the first
echo reporting a persist generation beyond the capture baseline marks
serverAppliedLocalState=true on the client [NON-NEGOTIABLE]
```

The current live Worker smoke proves the wire-level core of this path:

```text
manual connect receives baseline sv-echo
client writes local Yjs state
server sends postApply sv-echo
postApply echo's state vector dominates the client candidate SV
fresh second provider receives a baseline echo that dominates the prior candidate
server debug counters report baseline and postApply echo sends
```

---

## Implementation order

Implementation status:

1. **Pure client logic** — implemented:
   - `isStateVectorGe()` with full test matrix
   - `ServerAckTracker` candidate lifecycle with lifecycle tests
   - `recordServerSvEcho()`
   - Persisted candidate state store

2. **Server** — implemented:
   - `isUpdateBearingSyncMessage(message: WSMessage): boolean`
   - `trySendSvEcho()` wrapper with size/readyState/failure handling
   - `onConnect()` baseline echo
   - `handleMessage()` post-apply echo after successful parent handling

3. **Client** — implemented:
   - `provider.on("custom-message", ...)` registered before `provider.connect()`
   - detailed `parseSvEchoMessageDetailed()` failure reasons and counters
   - accepted SV echoes feed `ServerAckTracker.recordServerSvEcho()`

4. **`SyncFacts` / diagnostics** — implemented:
   - `serverAppliedLocalState`
   - `lastServerReceiptEchoAt` (diagnostic copy: last server receipt echo observed)
   - `lastKnownServerReceiptEchoAt`
   - `receiptGuaranteeIsDurable` and `serverPersistenceDegraded`
   - persistence health/failure fields
   - client and server SV echo counters

5. **Status label** — implemented in `src/status/statusBarController.ts`:
   - combines state + connection + timestamp
   - follows `receiptGuaranteeIsDurable`: "saved" wording only while it is true, with the
     legacy "received" wording and tooltip against fallback servers
   - surfaces `serverPersistenceDegraded` as its own "Server not saving" segment
   - says neither "synced" nor "confirmed" — a receipt proves neither

6. **Tests** — implemented for pure logic, server helpers, server wire shape, and live Worker smoke.

7. **Instrument** — implemented as cheap counters, not per-echo trace writes.
   Revisit batching if `svEcho.bytesMax` or echo rate becomes noisy under real typing.
   Server-side SV echo counters are in-memory Durable Object debug counters and
   may reset on DO restart, hibernation, or cold start.
