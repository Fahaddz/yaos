# Autophagy Branch Audit Report

**Date:** 2026-05-31  
**Repository:** do-sync (YAOS)  
**Audit range:** 39 commits (`3f5e306..HEAD`), merged into `main` via PR #54  
**Note:** `autophagy-branch` does not exist as a local branch; this audit covers the merged work on `main`.

---

## Executive Summary

The autophagy spike delivered real architectural progress — policy extraction, bundle splitting, QA fencing, schema guards — but **does not meet the behavior-freeze bar as a merge candidate**. Several claims are **directionally true** while **implementation gaps** remain.

| Claim | Functional verdict | Architectural verdict |
|---|---|---|
| A — Policy extraction preserved behavior | **PARTIAL** | Good module boundaries; wiring regression found |
| B — QA boundary prevents contamination | **MOSTLY YES** | String guards work; CI gap; residual QA hooks in Engine |
| C — Three-tier model is real | **PARTIAL** | Bundles split; Observer boundary not passive |
| D — TraceSink decoupling | **PARTIAL** | Interface exists; dual system; vaultSync still coupled |
| E — Telemetry split safe | **PARTIAL** | Normal users OK; debug-on is brittle |
| F — Schema regression impossible | **YES** | Guard born from real P1 failure; keep it |
| G — Canonical path identity | **PARTIAL** | Primitive fine; overclaimed scope |
| H — s01 bugs are harness | **MOSTLY YES** | Receipt wait has harness false-pass path |

**Bottom line:** Treat this branch as a **parts bin**, not a merge candidate — matching the user's prediction.

---

## Mechanical Proof Results

Commands run on `main` at audit time (2026-05-31).

### Production build & guards

```
npm run build                     → PASS
npm run guard:production-bundles  → PASS (main.js 490.7 KB, telemetry.js 69.5 KB)
npm run guard:schema-version      → PASS (v3 aligned)
npm run test:regressions          → PASS (84 suites, 0 failed)
```

### Symbol grep (production `main.js`)

| Symbol | Count in `main.js` | Count in `qa/obsidian-harness/product-main.js` |
|---|---|---|
| `getEngineControlPort` | 0 | 1 |
| `pauseEditorPropagation` | 0 | 1 |
| `setExternalEditPolicyOverride` | 0 | 1 |
| `__qaOnly` | 0 | 0 (harness API uses different surface) |
| `ingestDiskFileNow` | 2 (internal DiskIngestPort) | 4 |
| `setQaNetworkHold` | 1 | 1 |

Production omits harness control port symbols. Residual: `setQaNetworkHold` and internal `ingestDiskFileNow` remain in shipped Engine.

### QA builds

```
npm run build:qa-product  → PASS → qa/obsidian-harness/product-main.js
npm run build:harness     → PASS → qa/obsidian-harness/main.js
npm run qa:smoke-ready    → BUILD PASS; runtime FAIL (Obsidian CDP not running on :9222)
```

Smoke-ready builds succeed; live smoke requires Obsidian with remote debugging — not available in audit environment.

### Schema guard negative test

Temporarily set `SCHEMA_VERSION = 2` in `src/sync/schema.ts`:

```
FAIL: src/sync/schema.ts has SCHEMA_VERSION = 2, expected 3
→ guard exits 1
```

Guard detects version mismatch. Restored to v3 after test.

---

## Claim A — Policy Extraction Preserved Behavior

**Scope:** rename admission, closed-file planner, baseline advancement, safety brake, fingerprint quarantine, amplification quarantine.

### Functional evidence

| Question | Verdict | Finding |
|---|---|---|
| Move only vs change decisions? | **PARTIAL** | Safety brake, fingerprint/amplification quarantine, baseline advancement: move-only with tests. Rename admission: **intentional semantic change** (binary syncable/excluded → 9-case markdown/blob/excluded matrix). Closed-file planner: **wiring regression** on open/bound authoritative paths. |
| Old branches 1:1 in typed actions? | **PARTIAL** | Closed-file conflict decisions map cleanly. New planner-only branches (`defer-to-crdt-flush` for non-authoritative/open-bound). Rename is not 1:1. |
| Default/fallback branches identical? | **PARTIAL** | `planBaselineAdvancement` throws on unknown kind (stricter). Open/bound authoritative `updatedOnDisk`: old code flushed unconditionally; new code skips entirely. |
| Errors thrown where old code continued? | **PARTIAL** | Policy layer throws on programmer error (null hashes). Runtime paths with guards unchanged. |
| Traces at same semantic points? | **PARTIAL** | Safety brake, conflict preserve, disk-wins: yes. `reconcile.file.decision` payload uses action kinds not old decision kinds. Rename: `traceSink` domain events vs old `FLIGHT_KIND.diskRenameObserved`. |
| Baselines advanced at same times? | **PARTIAL** | CRDT-created, seed, conflict disk-wins, import, post-flush: preserved via `planBaselineAdvancement`. **Regression:** open/bound paths in authoritative `updatedOnDisk` no longer flushed or baselined. |

### Critical wiring regression

In `reconciliationController.ts`, the `updatedOnDisk` loop only enters the reconcile block when `mode === "authoritative" && !isOpenOrBound` (lines 759–764). Previously, `updatesToFlush.push(path)` ran for **every** path in `updatedOnDisk`, including open/bound files.

**Impact:** Authoritative reconcile mode can leave open/bound divergent files without flush or baseline update.

### Architectural evidence

- Pure policy modules in `src/runtime/reconcile/` are testable without Obsidian/Yjs/disk/network — **good**.
- Characterization tests exist: `tests/safety-brake-policy.ts`, `tests/fingerprint-quarantine-policy.ts`, `tests/amplification-quarantine-policy.ts`, `tests/baseline-advancement-policy.ts`, `tests/closed-file-planner.ts`, `tests/rename-admission-wiring.ts`.
- Behavior freeze declared in `docs/archive/autophagy-plan.md` but rename matrix and open/bound wiring violate strict interpretation.

### Prediction vs finding

**Predicted:** Most pure policy survives; baseline/rename wiring may need correction.  
**Found:** Confirmed — plus trace schema drift for analyzers.

---

## Claim B — QA Boundary Prevents Contamination

### Functional evidence

| Question | Verdict | Finding |
|---|---|---|
| Production omits unsafe symbols? | **MOSTLY YES** | `getEngineControlPort`, `pauseEditorPropagation`, `setExternalEditPolicyOverride`, `__qaOnly` absent from `main.js`. Guard passes. |
| QA product includes them? | **YES** | `product-main.js` has `getEngineControlPort`, control port methods. Harness fatal-checks for missing port. |
| Harness without product mounting `__YAOS_DEBUG__`? | **NO** (by design) | Product refuses to mount debug API; harness plugin mounts it. Scenarios require harness. |
| APIs unavailable vs renamed? | **RELOCATED** | Mutation API in `qa/harness/qaDebugApi.ts`; Engine control DCE-gated via `__YAOS_QA_HARNESS_ENABLED__`. |
| Guard fail closed? | **YES per script** | Both guards exit 1 on violation. **CI gap:** `release.yml` runs `test:ci` not `guard:production-bundles`. |
| Guard scans artifacts + source? | **YES** | `guard-production-bundles.mjs`: bundle strings + `src/` import fence. `guard-qa-isolation.mjs`: `src/sync`, `src/runtime`, `src/telemetry`. |

### Residual production surfaces

- `setQaNetworkHold` in `connectionController.ts` — present in production bundle (1 occurrence).
- `ingestDiskFileNow` as internal `DiskIngestPort` — allowed by guard, not user-facing.

### Architectural evidence

- Separate esbuild targets: production (`__YAOS_QA_HARNESS_ENABLED__: false`) vs QA product (`true`).
- `qa/harness/` not imported from `src/`.
- String-based guarding is better than nothing but not a type system — **as predicted**.

### Prediction vs finding

**Predicted:** Directionally valuable; guards need hardening.  
**Found:** Confirmed — add strict bundle guard to release CI; consider banning or documenting `setQaNetworkHold` in production.

---

## Claim C — Three-Tier Model Is Real

**Tiers:** Engine (`main.js`) · Observer (`telemetry.js`) · Puppeteer (`qa/harness/`, not shipped)

### Functional evidence

| Question | Verdict | Finding |
|---|---|---|
| Engine independent of Observer? | **RUNTIME YES, COMPILE PARTIAL** | Separate bundles. `vaultSync.ts` imports `FLIGHT_KIND` from `src/telemetry/debug/flightEvents`. |
| Engine starts if telemetry.js missing? | **DEPENDS** | `debug=false`: yes (NoopTraceSink). `debug=true`: **no** — uncaught `readFileSync` failure in `onload`. |
| Engine syncs if Observer fails? | **DEPENDS** | Load failure blocks `initSync`. Post-load observer errors: optional chaining, sync continues. |
| Observer mutates sync state? | **NOT BY DESIGN; YES BY CAPABILITY** | `TelemetryRuntimeHost` exposes `getVaultSync()`, `getReconciliationController()`, `getEditorBindings()` — mutable handles. |
| Read-only snapshots vs handles? | **MIXED** | `RuntimeDiagnosticsState` is scalar snapshot; live object getters remain. |
| Puppeteer in production bundles? | **NO** | `puppeteer`/`playwright` count 0 in `main.js` and `telemetry.js`. |

### Loaded-gun interfaces (confirmed)

From `src/telemetry/telemetryRuntimeHost.ts`:

```typescript
getVaultSync(): VaultSync | null;
getReconciliationController(): ReconciliationController;
getEditorBindings(): EditorBindingManager | null;
```

Comment acknowledges debt: "A future cleanup should replace them with narrow read-only ports."

### Doc drift

`docs/architecture/runtime-estates.md` references `src/lab/` (removed; Observer is `src/telemetry/`) and lists `__qaOnly*Unsafe` on product classes (removed in P2).

### Prediction vs finding

**Predicted:** Concept survives; Observer boundary weaker than advertised.  
**Found:** Confirmed exactly.

---

## Claim D — TraceSink Decouples Product from Diagnostics

### FLIGHT_KIND import sites (product vs observer)

**Still in product path:**
- `src/sync/vaultSync.ts` — value import of `FLIGHT_KIND` (CRDT lifecycle events)

**Migrated to domain/PRODUCT_EVENT_KIND:**
- `src/runtime/reconciliationController.ts`
- `src/sync/editorBinding.ts`
- `src/main.ts` (disk observation via `traceSink.recordPath`)

**Observer-only:**
- `flightTraceSink.ts`, `flightRecorder.ts`, `flightTraceController.ts`, `deviceWitnessTracker.ts`

### TraceSink behavior

| Question | Verdict | Finding |
|---|---|---|
| Silent drop of unknown events? | **YES** | `FlightTraceSink.recordPath`: unmapped kind → increment counter, return. `NoopTraceSink`: no-op. |
| Drops counted? | **PARTIAL** | `_droppedEventCount` in adapter only; not exported to UI/logs in production. |
| Critical events droppable? | **YES (observability only)** | e.g. `disk.delete.observed` with `priority: "critical"` — delete still runs regardless. |
| Product depends on trace emission? | **NO** | All flight callbacks use `lab?.` / optional chaining. |

### Dual observability system

1. Domain path: `main.ts` → `traceSink.recordPath()` (6 mapped kinds)
2. Product flight path: `PRODUCT_EVENT_KIND` → `recordFlightPathEvent`
3. Legacy lab path: `vaultSync` → `FLIGHT_KIND` → `onFlightPathEvent`

### Prediction vs finding

**Predicted:** Good direction; partial migration creates temporary dual system.  
**Found:** Confirmed — track migration completion; wire drop count into debug diagnostics.

---

## Claim E — Telemetry Bundle Split Is Safe

### Load path (`main.ts`)

When `settings.debug || settings.qaDebugMode`:

1. `fs.readFileSync(`${pluginDir}/telemetry.js`)` — **no try/catch**
2. `new Function(...)(telemetryCode)` — eval in Obsidian renderer
3. `installTelemetryRuntime({ ... mutable host ... })`

Path is plugin-local only — no remote URL.

### Failure modes

| Scenario | Sync blocked? | Diagnostics? |
|---|---|---|
| `debug=false`, telemetry absent | **No** | NoopTraceSink |
| `debug=true`, telemetry absent | **Yes** (onload throws) | N/A |
| `debug=true`, corrupt JS | **Yes** | N/A |
| Version skew main↔telemetry | **Undefined** | No handshake |
| Mobile + debug on | Same load path | Witness platform hardcoded `"desktop"` in installer |

### Tests

| Covered | Not covered |
|---|---|
| `tests/trace-sink.ts` (adapter mapping/drops) | Missing/corrupt telemetry.js at runtime |
| `guard-production-bundles.mjs` | Version mismatch between bundles |
| | Mobile telemetry load integration |

Release ships both bundles (`.github/workflows/release.yml`).

### Prediction vs finding

**Predicted:** Most controversial; runtime loading hacks hide bugs.  
**Found:** Confirmed — wrap load in try/catch with fallback to NoopTraceSink + user Notice before shipping telemetry split broadly.

---

## Claim F — Schema Regression Impossible

### Canonical chain

- `src/sync/schema.ts`: `SCHEMA_VERSION = 3`
- `src/sync/vaultSync.ts`: imports from `"./schema"` (no inlined export)
- `server/src/version.ts`: `SERVER_SCHEMA_VERSION = 3`

### Guard (`scripts/guard-schema-version.mjs`)

- In `test:regressions` via `package.json`
- Checks: schema.ts exists, vaultSync imports from schema, no inlined `export const SCHEMA_VERSION`, server pin matches the plugin
- **Limitation:** Does not catch non-export inlines or shadow imports
- **Deletion test:** Fails if `schema.ts` deleted

### Negative test

Setting `SCHEMA_VERSION = 2` → guard fails with exit 1. **Verified.**

### Prediction vs finding

**Predicted:** Worth keeping early.  
**Found:** Confirmed — born from real P1 (schema reverted during refactor, caught by smoke).

---

## Claim G — Canonical Path Identity Improved

### What works

- `canonicalizeVaultPath()`: NFC normalization, display path preserved
- Used in admission/classification (`pathCategory.ts`, `renameAdmissionPolicy.ts`)
- NFC/NFD same-identity renames suppressed (`same-identity` action → no CRDT mutation)
- Tests: `tests/canonical-path.ts`, `tests/path-category.ts`, `tests/rename-admission-wiring.ts`

### What is deferred / unused

- `findCanonicalPathCollisions()` — **only tested**, not wired to reconcile/import (`docs/archive/autophagy-plan.md` follow-up)
- Case collisions: no folding; `File.md` vs `file.md` are different keys — product decision deferred
- CRDT keys still use Obsidian `normalizePath` (`vaultSync.normPath`), not `canonicalPath` — **dual normalization risk** for NFC/NFD edge cases

### Prediction vs finding

**Predicted:** Primitive fine; danger is overclaiming.  
**Found:** Confirmed — do not claim "path identity solved" until collision enforcement ships.

---

## Claim H — Open s01 Bugs Are Harness, Not Engine

### waitForReceiptAfter

**Implementation:** `qa/harness/qaDebugApi.ts:461-489`

- Polls **current** VaultSync memory state, not receipt event history
- Primary path: candidate captured after timestamp AND confirmed ID matches candidate ID — **correct**
- **Fallback bug (lines 481-482):** passes on `lastKnownServerReceiptEchoAt > afterTimestamp` without checking pending unconfirmed candidate — can false-pass on stale confirmation while newer candidate pending

**Engine behavior:** `serverAckTracker.ts` correctly resets on new local update (lines 96-98).

**Product events:** sufficient — `receipt-candidate-captured`, `server.receipt.confirmed` traces + flight events.

### Premature file open

| Question | Verdict |
|---|---|
| Who calls openFile? | **Harness only** — `qa/obsidian-harness/editor-ops.ts` → `openLinkText`. No `openFile` in `src/`. |
| Obsidian workspace restore? | Product reacts to `layout-change` / `file-open`; does not proactively open files. |
| Harness setup opens file? | s01 setup: `waitForIdle` only. |
| Product opens during sync? | No — binds already-open views via `editorWorkspaceOrchestrator`. |

**s01 ordering:** create → receipt wait → disk/CRDT converge → **then** openFile (step 5). Opening before receipt would be harness sequencing choice, not engine behavior.

### Prediction vs finding

**Predicted:** At least one harness semantics issue; receipt wait smells like state not history.  
**Found:** Confirmed — fix fallback in `waitForReceiptAfter`; engine receipt emission is adequate.

---

## Claim → Proof Matrix

| Claim | Proof required | Result |
|---|---|---|
| A — behavior preserved | Policy unit tests + diff old/new reconcile paths | **FAIL** open/bound regression; rename semantics changed |
| B — production no QA API | build + strict guard + grep | **PASS** (with `setQaNetworkHold` residual) |
| C — three-tier real | bundle split + import graph + handle audit | **PARTIAL** bundles yes, passive Observer no |
| D — TraceSink decoupling | FLIGHT_KIND grep + drop behavior tests | **PARTIAL** vaultSync still coupled |
| E — telemetry split safe | failure mode tests + load isolation | **PARTIAL** normal users OK; debug brittle |
| F — schema guard | guard + regressions + negative test | **PASS** |
| G — canonical paths | usage grep + collision wiring | **PARTIAL** primitive only |
| H — harness vs engine | trace attribution + wait semantics | **MOSTLY harness** |

---

## Recommended Salvage Order

1. **Fix** open/bound authoritative `updatedOnDisk` flush regression (Claim A) — behavior bug, not refactor polish.
2. **Keep** schema guard, policy modules, QA product split, bundle guards — high value, proven.
3. **Harden** telemetry load: try/catch + NoopTraceSink fallback + version constant check (Claim E).
4. **Add** `guard:production-bundles` to release CI (Claim B).
5. **Migrate** `vaultSync` off `FLIGHT_KIND` to `PRODUCT_EVENT_KIND` / TraceSink (Claim D).
6. **Narrow** `TelemetryRuntimeHost` to read-only ports (Claim C).
7. **Fix** `waitForReceiptAfter` fallback (Claim H) — remove stale-echo false-pass.
8. **Defer** collision enforcement claims until `findCanonicalPathCollisions` is wired (Claim G).

---

## Artifacts

| Path | Description |
|---|---|
| `Unavailable in repository` | Historical local commit-stat dump (469 lines) |
| `docs/archive/audits/autophagy-ledger.md` | Claim → commit map and file classification |
| `/home/kavin/Desktop/autophagy-audit-report.md` | This report |

---

*Audit performed with 4 parallel code explorers, mechanical build/guard/regression runs, and intentional schema guard negative test. Live `qa:smoke-ready` requires Obsidian CDP — builds passed, runtime check skipped.*
