# Autophagy Branch Audit Report

**Repository:** `/home/kavin/github/do-sync`
**Branch:** `autophagy` (merged to `main` as PR #54)
**Commits audited:** 39 commits (`dafa5bd` → `9b38168`)
**Date of audit:** 2026-05-31
**Method:** Multi-agent static analysis; no live execution required for audit validity.

---

## Executive Summary

| Claim | Verdict | Confidence |
|-------|---------|------------|
| A: Policy extraction preserved behavior | **PARTIAL** | High |
| B: QA contamination prevention | **PARTIAL** | High |
| C: Three-tier model is real | **PARTIAL** | High |
| D: TraceSink decouples product from diagnostics | **PARTIAL** | High |
| E: Telemetry bundle split is safe | **PARTIAL / FAIL** | High |
| F: Schema regression is now impossible | **PARTIAL** | High |
| G: Canonical path identity is improved | **PARTIAL** | High |
| H: Open s01 bugs are harness, not engine | **PARTIAL** | High |

**No claim fully passes.** Most partial verdicts are "the core idea is correct and the implementation is substantially there, but specific holes exist." One claim (E) is close to a fail on robustness grounds and needs code changes before it can be trusted in the field.

**The predicted outcome** ("most of the pure policy extraction will be worth keeping, but one or two wiring changes will need correction; the telemetry loader is the most controversial part") was accurate. The review confirms almost exactly that distribution.

---

## Commit Ledger Summary

```
Claim A (policy extraction):
  4128476  extract path/rename admission policy
  df4d0ee  introduce canonical path identity; wire into admission layer
  38cc986  introduce TraceSink; migrate rename-admission traces
  a6f2080  extract closed-file reconcile planner
  0a50776  extract baseline advancement policy
  a48f67f  extract safety brake policy (Phase 4A)
  98a4851  extract fingerprint quarantine policy (Phase 4B)
  d997fbf  extract amplification quarantine policy (Phase 4C)
  46792cd  delete deprecated rename admission legacy path
  + associated test/cleanup commits

Claim B/C/E (three-tier, QA boundary, telemetry split):
  3776255  refactor(runtime): split Engine, Observer, Puppeteer
  47a8c66  remove Engine __qaOnly seams
  6d779e6  strip EngineControlPort via esbuild define
  bfa1e89  delete Puppeteer entrypoint, move Observer to src/telemetry
  ced50fd  mount __YAOS_DEBUG__ from harness plugin
  0c1fc07  harden mountYaosDebugApi
  6ed7c2f  load telemetry.js via eval+require
  18aab6e  restore schema v3 sync
  7b11851  align server constants, fix tombstone witness, add schema guard
  0484f21  QA: P4C liveness smoke, hermetic s01, atomic editor append
  9b38168  Merge PR #54

Claim D (TraceSink):
  38cc986  introduce TraceSink; migrate rename-admission traces
  07dc22c  TraceSink second cluster: migrate disk observation events
  1977766  fence QA APIs with explicit port interfaces

Claim F (schema guard):
  7b11851  fix(schema-v3-closure): add schema guard

Claim G (canonical path):
  df4d0ee  introduce canonical path identity
  4128476  extract rename admission policy (wiring)
```

---

## Claim A — Policy Extraction Preserved Behavior

**VERDICT: PARTIAL**

### What Passes

- **`safetyBrakePolicy`**: Exact 1:1 preservation. Constants identical (`SAFETY_BRAKE_MIN_COUNT=20`, `MIN_RATIO=0.25`), logic identical, reason string identical. ✓
- **`closedFilePlanner`**: All 5 action kinds map to the original 5 code branches. `mapConflictDecisionToAction` correctly derives `preserveSide`. ✓
- **`fingerprintQuarantinePolicy`**: All constants moved verbatim. TTL, threshold, map-size logic identical. ✓
- **`amplificationQuarantinePolicy`**: All 5 detection conditions preserved. History mutation semantics preserved (old in-place mutation → new immutable return, controller correctly applies). ✓
- **Test coverage**: All policy functions have standalone tests registered in `run-regressions.mjs`. Most pass cleanly.

### What Fails

**Finding A1 — `renameAdmissionPolicy` introduces new behavior.**
The intermediate API (`planRenameAction` / `decideRenameAdmission`) was deleted in commit `46792cd`. The current `planCategoryRenameAction` has 9 action kinds where the old inline code had 4. The specific behavioral changes:

- `same-identity` (NFC/NFD normalize to same canonical key): **new no-op**. Old code would have called `queueRename(nfc_path, nfd_path)`. This is a correctness improvement, but it is a behavioral change from pre-extraction baseline.
- `defer-blob-to-events` (`blob → excluded`): **new case**. Old code did not handle this explicitly.
- `admit-blob-via-event` (`excluded → blob`): **new case**. Old code did not cover this.
- Trace field name changed: `oldCategory` → `category` with added `opId`.

**Finding A2 — `baselineAdvancementPolicy` has two unwired action kinds.**
`live-disk-to-crdt` and `live-stat-only` are declared in `BaselineActionKind` (`baselineAdvancementPolicy.ts:29–30`) but have **zero production callers** anywhere in `src/`. The exhaustiveness `never` check means any future caller that passes them will fail with a throw — which is safer than silently continuing, but these dead slots make the tested policy surface larger than what is actually exercised.

**Finding A3 — `conflict-artifact-failed` is a dead action kind.**
`baselineAdvancementPolicy.ts:135–136` handles this kind, but `reconciliationController.ts:874–877` never calls `planBaselineAdvancement` when artifact creation fails — it `continue`s directly. The implicit behavior and explicit policy agree (both result in no hash write), but the action kind is untestable through any production path.

**Finding A4 — Test 11 in `amplification-quarantine-policy.ts` silently skips all assertions.**
`tests/amplification-quarantine-policy.ts:188–208`: the test setup triggers quarantine, making the `if (!result.quarantined)` block unreachable. The history-capping logic at `amplificationQuarantinePolicy.ts:104–107` is not covered by any test. The test passes because zero assertions execute.

**Finding A5 — `fingerprintQuarantinePolicy` imports from `diskIndex.ts` which imports `obsidian`.**
The file header claims the policy is testable without Obsidian, but `fingerprintQuarantinePolicy.ts` imports `contentFingerprint` from `diskIndex.ts`, which transitively imports from the `obsidian` package. Tests pass in the regression runner only because the regression environment patches `obsidian` as a mock.

**Finding A6 — Baseline advancement wiring: null hash now throws where old code wrote undefined.**
In `planBaselineAdvancement`, passing a null CRDT hash to a CRDT-authority action now throws. Old inline code would have silently written `await contentBaselineHash(null)` (producing a hash of empty string). This is a correctness improvement, but it is a behavioral change in the error path.

### Risk Assessment

| Policy | Risk | Action |
|--------|------|--------|
| safetyBrake | Low | Keep as-is |
| closedFilePlanner | Low | Keep as-is |
| baselineAdvancementPolicy | Medium | Document dead action kinds; fix Test 11 false-pass |
| fingerprintQuarantine | Low | Keep; fix import path if test isolation matters |
| amplificationQuarantine | Low-Medium | Fix Test 11 — it silently skips all assertions |
| renameAdmissionPolicy | Medium | NFC/NFD no-op is correct but was an undocumented semantic change; document it |

**Baseline advancement timing is preserved.** `settledHashes.set()` occurs at the same logical points as before extraction. Failed disk writes do not advance the baseline. Conflict artifact failures do not advance the baseline.

---

## Claim B — QA Contamination Prevention

**VERDICT: PARTIAL**

### What Passes

- Production `main.js` is genuinely clean of the most dangerous Engine control symbols. `getEngineControlPort`, `pauseEditorPropagation`, `resumeEditorPropagation`, `setExternalEditPolicyOverride`, `DeviceWitnessTracker`, `FlightRecorder`, etc. are **absent** (dead-code eliminated by esbuild `__YAOS_QA_HARNESS_ENABLED__=false`).
- QA product build (`qa/obsidian-harness/product-main.js`) correctly **retains** all these symbols (24× `_qaState`, 4× `ingestDiskFileNow`, etc.).
- `window.__YAOS_DEBUG__` is mounted exclusively by the harness plugin, never by the product plugin.
- The harness has 4 runtime guards before mounting that prevent it from attaching to a production build.
- `guard-production-bundles.mjs` fails **closed** on missing artifacts (exit 1 if `main.js` absent).

### What Fails

**Finding B1 — `setQaNetworkHold` + `_qaOfflineHold` ship in production bundle.**
`src/runtime/connectionController.ts:62`, `connectionController.ts:53`. These exist in `main.js`. The method requires private-field reflection to call (`(plugin as any).connectionController.setQaNetworkHold(...)`), so it is inaccessible without deliberate abuse, but it is a live mutation surface in production code. It is explicitly excluded from `guard-qa-isolation.mjs` as a "known exception to be migrated later" (`guard-qa-isolation.mjs:48–51`).

**Finding B2 — `__YAOS_DEBUG__` is not banned by `guard-production-bundles.mjs`.**
The guard does not list `__YAOS_DEBUG__` in any `FORBIDDEN` array. Its current production presence (3 occurrences: teardown cleanup and a developer warning log) is benign, but the guard does not enforce this. A future regression that mounts `window.__YAOS_DEBUG__` from `main.js` would not be caught.

**Finding B3 — `guard-qa-isolation.mjs` fails open on missing directories.**
`guard-qa-isolation.mjs:57–60`: if `src/sync/`, `src/runtime/`, or `src/telemetry/` do not exist (e.g., directory restructure), `readdirSync` throws and is silently caught, returning 0 violations. The guard vacuously passes. A directory rename would neutralize this guard with no CI failure.

**Finding B4 — Both guards are string-based only.**
`guard-production-bundles.mjs:141` uses `content.includes(symbol)`. An aliased import (`import { getEngineControlPort as gECP } from "..."`) or namespace import would evade all guards. There is no AST analysis or type-system enforcement at the bundle boundary.

**Finding B5 — Stale method declarations in `YaosQaDebugApi` interface.**
`qa/harness/qaDebugApi.ts:151,154,156,292` still declares four `__qaOnly*Unsafe` method names that are not implemented in the factory. The new names (`ingestDiskFileNow`, `pauseEditorPropagation`, etc.) are in the factory. The old interface declarations are dead type stubs.

**Finding B6 — `tests/qa-port-fencing.ts:78–85` uses stale method names.**
The mock `mockUnsafePort` includes the old `__qaOnly*Unsafe` names that no longer exist in `YaosUnsafeQaPort`. The test passes only because TypeScript types are erased at runtime and the validation logic checks for the `__qaOnly` substring (which the stale names still contain). The test does not catch the interface drift.

### Summary

The QA boundary exists and is substantially real. The most dangerous Engine mutation surfaces are absent from `main.js`. The gaps are: one live mutation method that was not fully migrated, two guard robustness issues, and string-only guard enforcement. The prediction was accurate: "directionally valuable, but first version has too much string-based guarding."

---

## Claim C — The Three-Tier Model Is Real

**VERDICT: PARTIAL**

### What Passes

- Engine does **not** statically import Observer implementation. The single `import type { TelemetryRuntimeHandle }` in `main.ts:85` is type-only and erased at compile time.
- In production mode (`debug=false`), Engine can start without `telemetry.js`. All `this.lab?.` calls use optional chaining; `NoopTraceSink` fallback is correct.
- In production mode, Engine can sync if Observer fails. All telemetry calls are fire-and-forget with optional chaining.
- Puppeteer code is **absent** from both production bundles. Multiple enforcement layers: esbuild dead-code elimination, `guard-production-bundles.mjs` (currently passing), `guard-qa-isolation.mjs` (currently passing).
- No CRDT writes exist in `src/telemetry/`. `guard:witness-readonly` enforces this; the DeviceWitnessTracker `markDirty()` path is read-compare-emit only.
- Release artifacts match the architecture doc: `main.js`, `telemetry.js`, `manifest.json`, `styles.css`. QA artifacts are not shipped. `lab.js` is permanently guarded against re-emergence.

### What Fails

**Finding C1 — Observer receives four broad mutable object handles.**
`src/telemetry/telemetryRuntimeHost.ts:65–68`:
```typescript
getVaultSync(): VaultSync | null;
getReconciliationController(): ReconciliationController;
getConnectionController(): ConnectionController | null;
getEditorBindings(): EditorBindingManager | null;
```
These are passed as live mutable objects from `src/main.ts:433–436`. The type system does not prevent Observer from calling mutating methods on them.

**Mitigating facts:**
- `getReconciliationController()`, `getConnectionController()`, and `getEditorBindings()` are **never actually called** by any code in `src/telemetry/`. They are declared but unused.
- `getVaultSync()` is called only for reads: `getTextForPath`, `isPathTombstoned`, `getActiveMarkdownPaths`, `observeMetaChanges`, etc.
- The architecture doc itself explicitly acknowledges this at `docs/architecture/runtime-estates.md:156–170` as tracked debt: "The passive boundary should be enforced by types, not convention."

**Finding C2 — Engine cannot start if `telemetry.js` is missing when `debug=true`.**
The loading block at `main.ts:410–463` has no `try/catch`. If `telemetry.js` is absent (or corrupt, or version-mismatched) when `debug=true`, `fs.readFileSync` throws an unhandled exception that propagates out of `onload()`, crashing the plugin entirely. This is covered in depth under Claim E.

**Finding C3 — `guard:witness-readonly` points to a stale path.**
`package.json` references `src/lab/diagnostics/deviceWitnessTracker.ts` (the old path prefix `src/lab/`). The file now lives at `src/telemetry/diagnostics/deviceWitnessTracker.ts`. This specific source-level guard silently passes because it scans a path that no longer exists. The artifact-level guard (`guard-production-bundles.mjs`) still catches violations in built output.

### Summary

The three-tier conceptual model is architecturally real. Engine/Observer/Puppeteer separation exists at the build, guard, and module-graph level. The gap is that the Observer boundary is enforced by convention (code review) rather than types at the four mutable handle sites. Three of those four handles are declared but never called. The prediction was accurate: "the three-tier idea survives review; the current Observer boundary probably does not fully survive."

---

## Claim D — TraceSink Decouples Product from Diagnostics

**VERDICT: PARTIAL**

### What Passes

- `src/main.ts` has no static `import { FLIGHT_KIND }` — this specific claim is true.
- `src/runtime/reconciliationController.ts` is fully migrated to `PRODUCT_EVENT_KIND`. Comment at `reconciliationController.ts:21` explicitly states: "no FLIGHT_KIND enum import."
- `src/sync/editorBinding.ts` uses `PRODUCT_EVENT_KIND` exclusively.
- `NoopTraceSink` is correctly implemented and is the default until telemetry loads.
- `FlightTraceSink.getDroppedEventCount()` exists and is tested.
- Product behavior does not depend on trace emission. All calls are fire-and-forget with optional chaining; no code branches on trace success/failure.

### What Fails

**Finding D1 — `src/sync/vaultSync.ts` still imports `FLIGHT_KIND` directly.**
`vaultSync.ts:38`: `import { FLIGHT_KIND } from "../telemetry/debug/flightEvents";`
Used at 4 call sites:
- `vaultSync.ts:1347` — `FLIGHT_KIND.crdtFileRevived` (priority: critical)
- `vaultSync.ts:1387` — `FLIGHT_KIND.crdtFileCreated`
- `vaultSync.ts:1682` — `FLIGHT_KIND.crdtFileRenamed`
- `vaultSync.ts:1788` — `FLIGHT_KIND.crdtFileTombstoned` (priority: critical)

This is not a minor omission. `vaultSync.ts` is the core CRDT management layer. All four CRDT lifecycle events emit via `this.onFlightPathEvent?.({...})`, not through `TraceSink`. When `lab` is null (production/no-debug), these events are dropped silently with no count.

**Finding D2 — `src/sync/diskMirror.ts` bypasses TraceSink entirely.**
`diskMirror.ts` emits events via a raw `_flightEventHandler` callback using string literals (e.g., `kind: "disk.write.ok"` at line 555, `kind: "disk.write.failed"` at line 597). These never pass through `TraceSink`.

**Finding D3 — `record()` on `FlightTraceSink` is a total no-op with no counter.**
`flightTraceSink.ts:69–72`:
```typescript
record(_event: DomainTraceEvent): void {
    // Non-path events not yet mapped in this phase.
}
```
Unlike `recordPath()` which at least increments `_droppedEventCount`, `record()` drops events completely invisibly. There is no counter, no log entry, no fallback.

**Finding D4 — `domainEvents.ts` covers only 2 event kinds.**
`src/observability/domainEvents.ts` defines typed interfaces for `RenameObservedEvent` and `RenameAdmissionInvariantFailedEvent` only. The full taxonomy (~40 FLIGHT_KIND constants) remains in `flightEvents.ts`. Migration is roughly 55–60% complete.

**Finding D5 — `main.ts` provider events bypass TraceSink.**
`main.ts:738,749,763` call `this.recordFlightEvent({kind: "provider.connected", ...})` with string literals, bypassing `traceSink` entirely. These 3 call sites were not migrated.

### Migration Completeness

| Component | Migrated? |
|-----------|-----------|
| `reconciliationController.ts` | Yes — uses `PRODUCT_EVENT_KIND` |
| `editorBinding.ts` | Yes — uses `PRODUCT_EVENT_KIND` |
| `main.ts` vault event handlers | Yes — uses `traceSink.recordPath()` |
| `vaultSync.ts` CRDT lifecycle events | **No** — uses `FLIGHT_KIND` directly |
| `diskMirror.ts` disk write events | **No** — raw callback bypass |
| `main.ts` provider events | **No** — raw `recordFlightEvent` calls |

The dual system is real and is not explicitly tracked or guarded. The prediction was accurate.

---

## Claim E — Telemetry Bundle Split Is Safe

**VERDICT: PARTIAL / FAIL**

This is the riskiest claim and the one most likely to need fixes before it can be trusted. The architecture is sound, but the loading path has unguarded failure modes that would crash the plugin entirely in debug mode.

### What Passes

- Architecture: `main.js` does not contain `DeviceWitnessTracker`, `FlightRecorder`, `FlightTraceController`, etc. Guard confirms.
- Normal startup (`debug=false`): completely unaffected. Telemetry block is never entered.
- Source constraint: `telemetryBundlePath` is assembled from `adapter.basePath + manifest.dir`. No network fetch, no user-controlled path.
- Release pipeline: both `main.js` and `telemetry.js` are built atomically in the same run (`esbuild.config.mjs:94–97`) and shipped together (`release.yml:43`).
- Observer/Engine separation: `TelemetryRuntimeHost` read-only reads confirmed; no CRDT writes in `src/telemetry/`.

### What Fails

**Finding E1 — CRITICAL: Missing `telemetry.js` crashes the plugin when `debug=true`.**
`src/main.ts:424`: `fs.readFileSync(telemetryBundlePath, "utf-8")` throws `ENOENT` if the file is absent. There is no `try/catch` anywhere in `onload()` around this block. The throw propagates out of `onload()`, Obsidian marks the plugin as failed, and sync does not start. The exact users most affected (debug users, QA users) are the ones who would encounter this.

**Finding E2 — CRITICAL: Corrupt `telemetry.js` crashes the plugin when `debug=true`.**
`main.ts:427`: `new Function("require", "module", "exports", "__filename", "__dirname", telemetryCode)` throws `SyntaxError` if the file content is invalid JavaScript. Truncated downloads, disk errors, or encoding corruption all result in total plugin failure. No fallback.

**Finding E3 — HIGH: Version-mismatched `telemetry.js` crashes or silently misbehaves.**
`main.ts:429` performs a TypeScript `as`-cast on `telemetryModule.exports`. If an older `telemetry.js` is present that does not export `installTelemetryRuntime`, the call at `main.ts:430` throws `TypeError: installTelemetryRuntime is not a function`. If the export exists but has a different signature, silent misbehavior. No version check exists.

**Finding E4 — HIGH: Mobile crash when `debug=true`.**
`main.ts:423` calls `require("fs")`. Node.js `fs` is not available in Obsidian's mobile renderer (WebView, not Electron). `require("fs")` throws `Error: Cannot find module 'fs'`. `manifest.json:9` states `"isDesktopOnly": false`, advertising mobile compatibility. Any mobile user who enables debug mode crashes on startup.

**Finding E5 — No tests for any failure mode.**
There are no tests for: telemetry.js missing (debug=true), corrupt/invalid JS, missing export, version mismatch, or mobile platform. This should have explicit tests. The scenarios that would validate the claim are:
```
debug=false, telemetry.js absent => sync starts          [currently passes, untested]
debug=true, telemetry.js absent => sync starts, diagnostics unavailable  [currently FAILS]
debug=true, telemetry.js malformed => sync starts, warning emitted       [currently FAILS]
debug=true, telemetry.js valid => diagnostics available                  [passes]
```

### Required Fixes

**Fix 1 (Critical):** Wrap the telemetry loading block in `try/catch` in `onload()` so failure degrades to `this.lab = null` with a warning Notice, not a plugin crash.

**Fix 2 (Critical for mobile):** Guard `require("fs")` behind `!Platform.isMobile`, or set `"isDesktopOnly": true` in `manifest.json`.

**Fix 3 (Medium):** Add a runtime check that `installTelemetryRuntime` is a function before calling it, to convert `TypeError: ... is not a function` into a clear diagnostic message.

**Fix 4 (Medium):** Add explicit tests for the four failure scenarios listed above.

The prediction was accurate: "not because the idea is bad, but because runtime loading hacks are where bugs hide."

---

## Claim F — Schema Regression Is Now Impossible

**VERDICT: PARTIAL**

### What Passes

- **Guard exists and is real.** `scripts/guard-schema-version.mjs` correctly detects the historical P1 vector: `export const SCHEMA_VERSION = N` re-declared in `vaultSync.ts`.
- **`schema.ts` deletion is caught.** `guard-schema-version.mjs:33–35` hard-fails if `src/sync/schema.ts` is missing.
- **Guard is in `test:regressions`.** `package.json:13`: it runs as step 4 of 5, before the regression suite runner. Also transitively in `test:ci`.
- **All three constants agree at v3.** `schema.ts:15`, `server/src/version.ts:9`, `server/src/version.ts:10` all read `3`. Cross-checked by the guard.
- **`vaultSync.ts` uses the canonical import.** No inline literal for the plugin's self-reported schema version.

### What Fails

**Finding F1 — Three inline bypass vectors exist.**

The guard checks only `export const SCHEMA_VERSION\s*=\s*\d` in `vaultSync.ts`. These patterns evade it:
1. Non-exported inline: `const SCHEMA_VERSION = 2` (no `export` keyword) passes check 4.
2. Direct string literal in provider params: `schemaVersion: "2"` in the `params()` closure passes all checks.
3. Inline in any other file: only `vaultSync.ts` is scanned. A developer who writes the value into `connectionController.ts` or `main.ts` is undetected.

**Finding F2 — Deleting `server/src/version.ts` produces a warning, not a failure.**
`guard-schema-version.mjs:75–76`: if the server version file is absent, the guard logs `WARN` and continues. `failures` is not incremented. The server alignment check silently passes.

**Finding F3 — Built artifact is not checked.**
The guard scans source files only. If esbuild were configured to replace `SCHEMA_VERSION` with a literal (via `--define`), the guard would pass while the bundle contains the wrong value. No such configuration is present today, but the guard has no defense against it.

**Finding F4 — `schema-guard.mjs` runtime test seeds at v2, not v3.**
The live integration test seeds a room at `schemaVersion=2` and tests v1/v2 rejection. It does not exercise the current production schema version (v3) in its rejection paths.

**Finding F5 — Server upper-bound not enforced at socket admission.**
`SERVER_MAX_SCHEMA_VERSION` is published to clients via `/api/capabilities` but the WebSocket admission at `syncSocket.ts:206` only enforces a lower bound (`clientSchema.version < roomSchemaVersion`). A v4 client connecting to a v3 server would not be rejected at admission.

### Summary

The guard catches the historically-observed failure mode with precision. The claim "impossible" is overstated — at least three bypass vectors exist. The guard is worth keeping and was born from a real failure, but it should be strengthened: add a hard failure for missing server version file, and consider scanning for `schemaVersion:` string literals in `vaultSync.ts` provider params.

---

## Claim G — Canonical Path Identity Is Improved

**VERDICT: PARTIAL**

### What Passes

- **Three primitives exist and are correct.** `canonicalizeVaultPath()`, `classifySyncPath()`, and `findCanonicalPathCollisions()` are implemented correctly and tested.
- **NFC/NFD same-identity renames are suppressed.** The `same-identity` check at `renameAdmissionPolicy.ts:65` compares `canonicalKey` values and no-ops NFC↔NFD renames. Correct and tested.
- **`displayPath` is preserved for Obsidian APIs.** All execution paths use `displayPath`, not `normalizedPath`. This is documented at three places. Correct design.
- **Case collision deferral is documented.** `canonicalPath.ts:15`: "Case folding (platform-dependent product decision, deferred)." This is correctly deferred.
- **Test coverage is complete for what is claimed.** 96 passing assertions across 4 test files, all in `run-regressions.mjs`.

### What Fails

**Finding G1 — `findCanonicalPathCollisions` has zero production callers.**
`src/paths/pathCollision.ts` is only imported in `tests/path-collision.ts`. No vault-startup scan, no pre-reconcile check, no pre-import guard uses it. The file-level comment explicitly states: "This module provides detection primitives only. Collision enforcement at admission boundaries is future work." The primitive exists; enforcement does not.

**Finding G2 — Canonicalization is applied at rename admission only.**
`src/runtime/reconciliationController.ts`, `src/sync/diskMirror.ts`, `src/sync/vaultSync.ts` all bypass `canonicalizeVaultPath`. The CRDT storage key path (`vaultSync.normPath` = Obsidian's `normalizePath`) is not NFC-aware. On macOS (HFS+ emits NFD paths), a path seeded at startup via `normPath` (NFD) and later renamed via the rename handler (NFC after canonicalization) would produce two CRDT entries for the same logical file. This is an existing gap, not a regression, but the claim that "path identity is improved" is only partial.

**Finding G3 — Minor behavior change on existing vaults.**
NFC↔NFD renames are now no-ops. Before extraction, such a rename would have called `queueRename(nfd_path, nfc_path)`. For most users this is correct, but a vault with existing NFC/NFD CRDT collisions would have the collision suppressed rather than actioned.

### Summary

The primitives are correct. The claim boundary is honest ("vault-wide collision enforcement is explicitly future work"). The main risk is overclaiming: "path identity is improved" is true at rename admission; it is not improved anywhere else in the sync pipeline. The prediction was accurate.

---

## Claim H — Open s01 Bugs Are Harness, Not Engine

**VERDICT: PARTIAL**

Two of three open bugs are harness bugs. One is a product diagnostic bug. None are sync-engine correctness defects.

### Bug #1 — `waitForReceiptAfter` Takes ~18.9s

**Attribution: HARNESS BUG (fully resolved in commit 0484f21).**

Root cause: `createTs = Date.now()` was captured **after** `waitForIdle(8000)`. By the time the anchor was set (~t+8s), the engine had already confirmed the receipt at t+0.67s. The edge-triggered predicate correctly failed, then had to wait for a new Y.Doc update to fire after t+8s.

The fix in `0484f21` moves `createTs` capture to before `createFile`. The fallback predicate (`qaDebugApi.ts:481–483`) uses the sticky `_lastKnownServerReceiptEchoAt`, which is never reset by new candidate captures.

**Secondary mechanism confirmed:** New local Y.Doc updates do invalidate the primary predicate (`_lastCandidateId` advances, making `confirmedId !== candidateId`). The fallback path correctly handles this. The engine's emission is sufficient; the timestamp anchor placement was the defect.

**Latent risk:** `_lastKnownServerReceiptEchoAt` is persisted to IDB (`serverAckTracker.ts:353`). A prior session's confirmed receipt timestamp could satisfy `confirmedAt > afterTimestamp` spuriously, giving a false-positive pass. Not fixed in 0484f21.

### Bug #2 — Premature File Open at t+0.81s

**Attribution: HARNESS SETUP BUG (partially addressed in 0484f21, not fully resolved).**

Root cause: `qa/scripts/prepare-vault.ts:96–106` does not write `workspace.json`. Obsidian restores its previous workspace state on startup. If a prior s01 run left a file open, the next session restores that tab before any scenario code runs.

`0484f21` introduced unique scratch paths (`scratchPath()`) which prevents the old static path from persisting in `workspace.json` across runs. But Obsidian may still auto-open newly created files in some vault configurations.

**Product code confirmed clean:** No `workspace.openLinkText()`, `workspace.openFile()`, or editor-open API exists anywhere in `src/`. The product only responds to open events; it never initiates them.

**Remaining open:** `prepare-vault.ts` should write a clean `workspace.json` to prevent workspace restore from opening any files.

### Bug #3 — `getCrdtHash(path)` Disagrees with `checkpoint.hashMismatches=0`

**Attribution: PRODUCT DIAGNOSTIC BUG in `src/main.ts:1653`.**

`buildFlightCheckpoint()` at `main.ts:1642–1659` returns hardcoded `hashMismatches: 0` — the hash comparison logic is never executed. The real comparison logic exists in `src/telemetry/diagnostics/diagnosticsBundle.ts:127–135` but was never wired into the lightweight flight checkpoint.

`getCrdtHash(path)` in `qa/harness/qaDebugApi.ts:521–529` does a live CRDT lookup and returns the real hash. The two sources are inconsistent.

This is a product code bug, but it is diagnostics/observability only. Sync correctness is unaffected.

### Summary

| Bug | Layer | Status |
|-----|-------|--------|
| `waitForReceiptAfter` 18.9s | Harness | Fixed in 0484f21 |
| Premature file open | Harness setup | Partially addressed (unique paths); `workspace.json` initialization still missing |
| `hashMismatches=0` hardcoded | Product diagnostic code | Open — `buildFlightCheckpoint` never computes real hash diff |

The prediction "at least one of these is harness semantics" was correct. All three have harness or diagnostic-layer attribution; none are sync-engine correctness bugs.

---

## Cross-Cutting Findings

### Predicted vs Actual Outcomes

| Prediction | Actual |
|-----------|--------|
| "Most pure policy modules will survive" | **Confirmed.** 5 of 6 policies are substantially preserved. |
| "Some wiring around baseline advancement and rename admission will need adjustment" | **Confirmed.** Rename admission has 4 new action kinds (no pre-extraction counterpart). Baseline has 2 dead action kinds and one dead `conflict-artifact-failed` case. |
| "Three-tier architecture survives as a concept" | **Confirmed.** |
| "Observer boundary weaker than advertised" | **Confirmed.** Four mutable handles passed; 3 never called; boundary is convention-only. |
| "Telemetry loader most controversial" | **Confirmed.** Two critical unguarded failure modes; no tests for failure scenarios. |
| "QA boundary worth keeping, guards need hardening" | **Confirmed.** String-only guards, fail-open on missing directories, one live seam not migrated. |
| "At least one open s01 bug is harness semantics" | **Confirmed.** Two are harness, one is product diagnostics. |
| "Branch becomes parts bin, not merge candidate" | **Status unknown** — the branch was merged as PR #54. The audit finds the merge introduced known risks (particularly Claim E's unguarded crash paths). |

### High-Priority Action Items

These are ordered by risk to production users:

1. **[CRITICAL] Wrap telemetry loading in `try/catch`** (`src/main.ts:410–463`). Current behavior: `debug=true` + missing or corrupt `telemetry.js` = plugin crash. Required behavior: graceful degradation to `this.lab = null` with a warning Notice.

2. **[CRITICAL] Guard telemetry loading behind `!Platform.isMobile`** (`src/main.ts:410`). Current behavior: `debug=true` on mobile = `require("fs")` throws, plugin crash. `manifest.json` advertises `"isDesktopOnly": false`.

3. **[HIGH] Add tests for telemetry failure modes.** Four scenarios need tests: missing file, corrupt file, missing export, wrong version — all with `debug=true` and the expected result being graceful degradation, not crash.

4. **[MEDIUM] Fix Test 11 in `amplification-quarantine-policy.ts`** (`tests/amplification-quarantine-policy.ts:188–208`). The test silently skips all assertions. The history-capping code is untested.

5. **[MEDIUM] Document `same-identity` as a deliberate behavioral change** in rename admission changelog/engineering notes. NFC↔NFD renames are now no-ops. This is correct, but it is a behavioral change from the pre-extraction baseline that was not explicitly called out.

6. **[MEDIUM] Fix `guard:witness-readonly` path.** `package.json` references `src/lab/diagnostics/deviceWitnessTracker.ts`. The file is now at `src/telemetry/diagnostics/deviceWitnessTracker.ts`. The source-level guard silently passes on a stale path.

7. **[LOW] Add `__YAOS_DEBUG__` to `MAIN_FORBIDDEN`** in `guard-production-bundles.mjs`. Current benign occurrences are teardown cleanup and developer log. Guard does not enforce this.

8. **[LOW] Fix `guard-qa-isolation.mjs` to fail closed** on missing directories. Current behavior: silently returns 0 violations if `src/sync/`, `src/runtime/`, or `src/telemetry/` are absent.

9. **[LOW] Add explicit `server/src/version.ts` missing = hard failure** to `guard-schema-version.mjs`. Current: warning only.

10. **[LOW] Wire `buildFlightCheckpoint` to compute real hash diff** or remove `hashMismatches` from the checkpoint output. Hardcoded `0` disagrees with live `getCrdtHash()` API, creating misleading diagnostics for RCA.

---

## File Classification Index

Files that appear in multiple claim categories (highest scrutiny):

| File | Categories | Risk |
|------|-----------|------|
| `src/main.ts` | SYNC_ENGINE + OBSERVABILITY + TELEMETRY_LOADER + QA_BOUNDARY | **High** |
| `esbuild.config.mjs` | BUILD_RELEASE + QA_HARNESS + TELEMETRY_LOADER | **High** |
| `src/runtime/reconciliationController.ts` | SYNC_ENGINE + RECONCILE_POLICY + OBSERVABILITY | Medium |
| `src/sync/vaultSync.ts` | SYNC_ENGINE + OBSERVABILITY | Medium |
| `scripts/guard-production-bundles.mjs` | GUARD_TOOLING + BUILD_RELEASE | Medium |
| `src/debug/flightTraceSink.ts` | OBSERVABILITY + TELEMETRY_LOADER | Medium |
| `src/telemetry/installTelemetryRuntime.ts` | TELEMETRY_LOADER + OBSERVABILITY | Medium |

---

*End of report. Generated by multi-agent static analysis of 39 commits, ~50 source files, guard scripts, build configuration, and QA harness infrastructure.*
