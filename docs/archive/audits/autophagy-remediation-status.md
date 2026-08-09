# Autophagy Audit Remediation Status

**Date:** 2026-08-09
**Audit reports:** `docs/archive/audits/autophagy-audit-report.md`, `docs/archive/audits/autophagy-audit-report2.md`
**Audit ledger:** `docs/archive/audits/autophagy-ledger.md`
**Implementation patch:** uncommitted work on `main` (15 tracked files + 2 new files)

---

## Summary

This patch addresses the highest-priority findings from the June 2026 autophagy
audit. It does not attempt to close the entire audit; explicitly deferred items
are documented below.

---

## Resolved findings

| Audit finding | Resolution | Evidence |
|---|---|---|
| **E1** Missing `telemetry.js` crashes plugin when `debug=true` | `telemetryLoader.ts` handles `file-missing` gracefully; sync continues with `NoopTraceSink` | `tests/telemetry-loader.ts` Scenario 1 |
| **E2** Corrupt `telemetry.js` crashes plugin | Loader handles `eval-error` gracefully | Scenario 2 |
| **E3** Wrong export shape crashes plugin | Loader validates export is a function before calling | Scenarios 3, 6, 7 |
| **E3b** `installTelemetryRuntime` throws at runtime | Loader catches and returns `runtime-error` | Scenario 4 |
| **E4** Mobile crash when `debug=true` (`require("fs")` unavailable) | `Platform.isMobile` guard skips telemetry load entirely | `src/main.ts` mobile guard |
| **E5** No failure-mode tests | Seven scenarios covering all five failure paths plus success | `tests/telemetry-loader.ts` |
| **C1** Observer receives mutable `VaultSync` handle | Replaced with `SyncReadPort` (read-only interface) | `src/telemetry/telemetryRuntimeHost.ts` |
| **D1** `vaultSync.ts` imports `FLIGHT_KIND` directly | Replaced with `PRODUCT_EVENT_KIND`; events routed through `TraceSink` | `src/sync/vaultSync.ts` diff |
| **D3** `record()` on `FlightTraceSink` drops invisibly | Now increments `_droppedEventCount` | `src/telemetry/debug/flightTraceSink.ts` |
| **A4** Test 11 amplification quarantine false-pass | Split into 11a (non-monotonic prevents quarantine) and 11b (monotonic triggers quarantine with eviction proof) | `tests/amplification-quarantine-policy.ts` |
| **B3** `guard-qa-isolation.mjs` fails open on missing directories | Guard now checks `existsSync()` and fails closed | `scripts/guard-qa-isolation.mjs` |

## Partially resolved

| Finding | Current state | Remaining work |
|---|---|---|
| **B1** `setQaNetworkHold` in production | Symbol absent from `main.js`; listed in `MAIN_FORBIDDEN` and `TELEMETRY_FORBIDDEN`; guard enforces absence | None — resolved |
| **D** TraceSink migration completeness | CRDT lifecycle and reconcile-deferred events migrated; adapter mapping test covers all routed kinds | `diskMirror.ts` raw callbacks, `main.ts` provider events, and remaining path-scoped product events remain outside TraceSink |

## Explicitly deferred (not in scope of this patch)

| Finding | Reason |
|---|---|
| **C3** `guard:witness-readonly` stale path (`src/lab/...`) | Cosmetic; artifact-level guard still catches violations |
| **D2** `diskMirror.ts` bypasses TraceSink | Requires broader refactor; product behavior unaffected |
| **D4** `domainEvents.ts` covers only 2 kinds | Domain event type coverage is incremental; no product regression |
| **D5** `main.ts` provider events bypass TraceSink | Low-risk; events fire-and-forget with optional chaining |
| **F2** Server version file deletion produces warning not failure | Low risk; server CI separately validates |
| **G1** `findCanonicalPathCollisions` unused in production | Detection primitive exists; enforcement is future work |
| Real-device telemetry failure smoke (desktop/mobile) | Unit tests cover loader logic; real-device validation deferred by decision |

## New capabilities introduced by this patch

- `src/telemetry/telemetryLoader.ts` — isolated loader with dependency injection for testing.
- `SyncReadPort` interface — type-enforced read-only Observer boundary.
- `PRODUCT_EVENT_KIND.reconcileFileDeferred` — telemetry for open/bound file reconcile skip.
- `PRODUCT_EVENT_KIND.renameAdmissionCanonicalCollision` — telemetry for NFC/NFD CRDT collision.
- `reconcile.file.deferred` flight event via `FlightTraceSink` adapter mapping.
- Characterization tests for open/bound file planner behavior (Tests 12-14 in `closed-file-planner.ts`).

## Behavioral notes

### Open/bound file reconcile deferral is intentional

The June audit flagged the `updatedOnDisk` loop no longer flushing open/bound files
as a "wiring regression" (Finding A, `a6f2080`). After investigation, this patch
concludes the old flush was the dangerous behavior: it raced with `vault.modify` ->
`syncFileFromDisk` -> `handleBoundFileSyncGap`. The new behavior correctly defers
to the live editor binding path. See `tests/closed-file-planner.ts` characterization
comments for the full convergence analysis.

---

## Verification commands

```bash
npx tsc --noEmit --skipLibCheck
npm run test:regressions
npm run build
npm run guard:production-bundles:strict
npm run build:qa-product
git diff --check
```

All pass on this worktree as of 2026-08-09.
