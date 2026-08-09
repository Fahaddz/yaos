# Runtime Estates

This document defines the three runtime estates of this codebase and their
boundaries. It is the authoritative reference for what belongs where and why.
For source ownership, build products, and generated-output policy, see
[Repository layout](repo-layout.md).

## The three estates

```
Engine      = src/ product sync runtime          → main.js
Observer    = src/telemetry/                      → telemetry.js
Puppeteer   = qa/harness/                         → not shipped
```

### Engine — `main.js`

- Product sync runtime: VaultSync, ReconciliationController, EditorBindingManager,
  DiskMirror, BlobSyncManager, ConnectionController, SnapshotService, etc.
- Ships to users on every release.
- Must not import from `src/telemetry/` or `qa/`.
- Must not contain mutation harness code or Puppeteer scenario controls.

### Observer — `telemetry.js`

Loaded dynamically by `main.js` when `settings.debug` or `settings.qaDebugMode`
is enabled. Never loaded in a normal user session.

**May contain:**

- `FlightRecorder`, `FlightTraceController`, `FlightTraceSink`
- `DeviceWitnessTracker`
- `DiagnosticsService`
- `PersistentTraceLogger`
- Read-only / passive diagnostics commands

**Must not contain:**

- VFS torture (`VfsTortureTest`)
- Scenario controllers (`ScenarioStateController`, `setScenarioRunId`, `advanceScenarioStep`)
- Unsafe CRDT / sync mutation (`forceCrdtContent`, `ForceSyncFileFromDisk`, `__qaOnly*`)
- Network holds (`setQaNetworkHold`)
- Editor binding mutation (`pauseBindingPropagation`, `resumeBindingPropagation`)
- Anything in `qa/harness/`

The production bundle guard (`scripts/guard-production-bundles.mjs`) enforces
this. Run `npm run verify:bundles` after every build.

### Puppeteer — `qa/harness/` (not shipped)

Mutation harness used by Puppeteer-driven QA scenarios. Never bundled into
`main.js` or `telemetry.js`. Not loaded in production.

**Contains:**

- `installPuppeteerRuntime.ts` — Puppeteer entry point
- `qaDebugApi.ts` — `window.__YAOS_DEBUG__` mutation API
- `scenarioStateController.ts` — scenario step mutation
- `vfsTortureTest.ts` — VFS stress test
- `ports/yaosUnsafeQaPort.ts` — unsafe QA port interface

## Directory map

```
src/
  main.ts                     Engine entry point
  runtime/                    Engine: reconcile, connection, attachment, trace
  sync/                       Engine: CRDT sync, editor bindings, disk mirror, blob
  settings/                   Engine: settings
  observability/              Product-owned event/trace types (no Observer internals)
    productEventKinds.ts      PRODUCT_EVENT_KIND string constants used by Engine
    traceSink.ts              TraceSink interface + ProductFlightEvent* types
    traceContext.ts           TraceHttpContext, TraceEventDetails, TraceRecord types
    traceLogger.ts            TraceLoggerPort interface
  telemetry/                  Observer implementations, entry, and host interface
    debug/                    FlightRecorder, FlightTraceController, FlightTraceSink
    diagnostics/              DeviceWitnessTracker, DiagnosticsService, PathRedactor
    installTelemetryRuntime.ts
    telemetryRuntimeHost.ts
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

## Release artifacts

A release ships exactly these files:

```
main.js       Engine bundle
telemetry.js  Observer bundle (loaded dynamically when debug mode enabled)
manifest.json Obsidian plugin manifest
styles.css    Plugin styles
yaos.zip      Convenience zip of the above
```

These are never shipped:

```
lab.js        (legacy name — must not reappear; esbuild no longer emits it)
qa/           Puppeteer harness source
qa-runs/      Run artifacts
```

## Enforcement

The build (`npm run build`) emits `main.js` and `telemetry.js`. `lab.js` is not
emitted. If `lab.js` ever reappears in the root, it is a sign the esbuild config
has regressed. The `guard:no-lab-artifact` script in `package.json` fails the
build if `lab.js` is present.

```
npm run build                                  build both bundles
npm run verify:bundles                         build + run the local transitional bundle guard
npm run guard:production-bundles:strict        fail on any forbidden symbol (used by CI and release)
npm run guard:production-bundles:transitional  allow only explicitly deferred symbols for local checks
npm run guard:no-tracked-generated-artifacts   fail if generated bundles, QA output, or QA run artifacts are tracked
npm run guard:qa-isolation                      confirm src/ does not import from qa/
```

The P2 cleanup removed the former `__qaOnly*Unsafe` Engine seams. The strict
production-bundle guard permanently rejects those symbols if they reappear.

## Known debt

### TelemetryRuntimeHost broad object handles (deferred)

`TelemetryRuntimeHost` currently exposes full mutable objects:

```typescript
getVaultSync(): VaultSync | null;
getReconciliationController(): ReconciliationController;
getConnectionController(): ConnectionController | null;
getEditorBindings(): EditorBindingManager | null;
```

These objects can mutate state. The current Observer implementation only reads
from them, but the type system does not enforce that. A future cleanup should
replace these with narrow read-only ports or snapshot types. The passive
boundary should be enforced by types, not convention.
