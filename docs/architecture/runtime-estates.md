# Runtime Estates

This document defines the runtime estates of this codebase and their
boundaries. It is the authoritative reference for what belongs where and why.
For source ownership, build products, and generated-output policy, see
[Repository layout](repo-layout.md).

## The two estates

```
Product     = src/ (sync engine + debug runtime)  → main.js
Puppeteer   = qa/                                 → not shipped
```

There used to be a third estate, "Observer", compiled to a separate
`telemetry.js` bundle that `main.js` read off disk and evaluated. That bundle
is gone. Its code now compiles into `main.js` with everything else.

### Product — `main.js`

One bundle, shipped to users on every release. It contains:

- The sync runtime: VaultSync, ReconciliationController, EditorBindingManager,
  DiskMirror, BlobSyncManager, ConnectionController, SnapshotService, etc.
- The debug runtime under `src/telemetry/`: FlightRecorder,
  FlightTraceController, FlightTraceSink, PersistentTraceLogger,
  DeviceWitnessTracker, diagnostics, and the read-only debug commands.

The debug runtime is inert unless the `debug` setting is on. With `debug: false`
nothing is recorded, the flight recorder is never started, and the sync runtime
writes to a no-op trace sink. Turning `debug` on starts the flight recorder;
there is no second switch.

It must not contain mutation harness code, scenario controls, or Engine control
capabilities. `scripts/guard-production-bundles.mjs` enforces that against the
built bundle; run `npm run verify:bundles` after a build.

### Puppeteer — `qa/` (not shipped)

Mutation harness used by Puppeteer-driven QA scenarios. Never bundled into
`main.js`. Not loaded in production.

**Contains:**

- `installPuppeteerRuntime.ts` — Puppeteer entry point
- `qaDebugApi.ts` — `window.__YAOS_DEBUG__` mutation API
- `scenarioStateController.ts` — scenario step mutation
- `vfsTortureTest.ts` — VFS stress test
- `ports/yaosUnsafeQaPort.ts` — unsafe QA port interface

QA scenarios run against `qa/obsidian-harness/product-main.js`, a separate
product build made with `__YAOS_QA_HARNESS_ENABLED__=true`. That build is not a
release artifact.

## The boundary is a type, not a bundle

The debug runtime must never mutate sync state. That guarantee comes from one
place: `src/main.ts` hands it a `SyncReadPort` — a flat set of read-only
scalars plus a handful of read methods — instead of the `VaultSync` object. The
debug runtime therefore cannot hold a `Y.Text` or `Y.Map`, and cannot call a
mutating method, because no such thing is reachable through the port's type.
This is checked by `tsc`, at every build, on every call site.

Be clear about what the old two-bundle layout did and did not buy:

- It did **not** provide isolation. Both bundles ran in the same V8 realm, in
  the same Obsidian renderer process, sharing globals and prototypes. The host
  object handed across the seam included the entire Obsidian `App`, which the
  debug runtime used for `vault.adapter.write/mkdir/append` and `vault.read`.
  The debug runtime also imported product modules directly.
- It did **not** provide independent versioning. Both bundles were built in the
  same run and shipped in the same zip. The hand-maintained ABI integer only
  ever detected a mismatch a user could not create.
- What it cost was real: `readFileSync` of a sibling bundle, `new Function`
  evaluation, a loader with six distinct failure modes, and a `debug: true`
  path that broke on mobile because `require("fs")` does not exist there.

Deleting the split removed the cost and kept the protection, because the
protection was never the split.

Corollary for reviewers: a change that lets the debug runtime reach `VaultSync`,
a Yjs handle, or any mutating method is a regression, whether or not it touches
bundle configuration. The forbidden capabilities are listed at the top of
`src/telemetry/telemetryRuntimeHost.ts`.

## Directory map

```
src/
  main.ts                     Plugin entry point; builds the SyncReadPort
  runtime/                    Reconcile, connection, attachment, trace
  sync/                       CRDT sync, editor bindings, disk mirror, blob
  settings/                   Settings store and settings tab
  observability/              Product-owned event/trace types (no debug internals)
    productEventKinds.ts      PRODUCT_EVENT_KIND string constants
    traceSink.ts              TraceSink interface + ProductFlightEvent* types
    traceContext.ts           TraceHttpContext, TraceEventDetails, TraceRecord types
    traceLogger.ts            TraceLoggerPort interface
  telemetry/                  Debug runtime, gated by the `debug` setting
    debug/                    FlightRecorder, FlightTraceController, FlightTraceSink,
                              PathIdentityResolver
    diagnostics/              DeviceWitnessTracker, DiagnosticsService, PathRedactor
    debug/ports/
      yaosDebugPort.ts        YaosDebugPort interface (canonical — used by QA + tests)

qa/
  harness/                    Puppeteer mutation harness (not shipped)
  obsidian-harness/           Obsidian plugin shim for QA (not shipped)
  analyzers/                  Offline flight trace analyzers (not shipped)
  controllers/                Puppeteer test controllers (not shipped)
  scripts/                    QA utility scripts (not shipped)
  fixtures/                   Test vault fixtures (not shipped)

qa-runs/                      GITIGNORED — generated flight traces, run artifacts
```

The product runtime outside `src/telemetry/` must not import from
`src/telemetry/` implementations; it depends only on the interfaces in
`src/observability/`. Nothing in `src/` may import from `qa/`.

## Release artifacts

A release ships exactly these files:

```
main.js       Product bundle (sync engine + debug runtime)
manifest.json Obsidian plugin manifest
styles.css    Plugin styles
yaos.zip      Convenience zip of the above
```

These are never shipped:

```
qa/           Puppeteer harness source
qa-runs/      Run artifacts
```

A checkout that predates the fold may still have a stale `telemetry.js` in the
repository root from an old build. Nothing generates, ignores, ships, or loads
it any more; delete it.

## Enforcement

```
npm run build                                  build main.js
npm run verify:bundles                         build + run the local transitional bundle guard
npm run guard:production-bundles:strict        fail on any forbidden symbol (used by CI and release)
npm run guard:production-bundles:transitional  allow only explicitly deferred symbols for local checks
npm run guard:no-tracked-generated-artifacts   fail if generated bundles, QA output, or QA run artifacts are tracked
npm run guard:qa-isolation                     confirm src/ does not import from qa/
```

The bundle guard is an output check and can only see strings. It proves that no
QA or mutation capability reached the shipped bundle. It cannot prove the
read-only boundary; that is the `SyncReadPort` type's job, and `tsc` is what
enforces it.

The P2 cleanup removed the former `__qaOnly*Unsafe` Engine seams. The strict
production-bundle guard permanently rejects those symbols if they reappear.

## Known debt

### The debug runtime still receives the Obsidian `App`

`TelemetryRuntimeHost` hands over `app: App` because the flight recorder and
the diagnostics exporter write their output through
`app.vault.adapter.write/mkdir/append` and read it back with `app.vault.read`.
That is a broad handle: anything reachable from `App` is reachable from the
debug runtime, including the vault's files.

What it is *not* is a route to sync state. The CRDT is unreachable: the only
sync-state channel on the host is `getSyncState(): SyncReadPort | null`, and
the port carries read-only scalars plus read methods — no `VaultSync`, no
`Y.Doc`, no `Y.Text`, no `Y.Map`. Narrowing `app` to a small file-writing port
is the remaining cleanup; it is independent of the bundle layout, and it was
never bought by the old bundle split either.
