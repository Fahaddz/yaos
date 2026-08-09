# Autophagy Commit Ledger

**Audit range:** `3f5e306..HEAD` (39 commits)  
**Branch note:** `autophagy-branch` is not present locally; work is merged into `main` via PR #54 (`p0-salvage-telemetry-split`).  
**Commit dump:** unavailable in this repository; the original audit cited a local historical dump.

## Claim → Commit Map

| Claim | Commits (hash prefix) | Primary files | Risk | Evidence needed | Evidence found | Notes |
|---|---|---|---|---|---|---|
| **A** Policy extraction preserved behavior | `4128476`, `df4d0ee`, `a6f2080`, `0a50776`, `a48f67f`, `98a4851`, `d997fbf`, `46792cd`, `a8e1b95` | `src/runtime/reconcile/*`, `src/sync/policy/renameAdmissionPolicy.ts`, `reconciliationController.ts`, `main.ts`, `tests/*-policy.ts` | **HIGH** | Diff vs pre-extraction; characterization tests; baseline timing; trace parity | See final report §A | Pure policy modules mostly preserved; wiring regression on open/bound authoritative `updatedOnDisk`; rename semantics intentionally changed |
| **B** QA boundary prevents contamination | `1977766`, `a23dd66`, `6d779e6`, `ced50fd`, `0c1fc07`, guard scripts | `esbuild.config.mjs`, `scripts/guard-*.mjs`, `src/runtime/engineControlPort.ts`, `qa/harness/*` | **MEDIUM** | Production bundle grep; QA product build; guard pass/fail; CI wiring | See final report §B | Strict guard passes locally; `setQaNetworkHold` + internal `ingestDiskFileNow` remain in production `main.js`; release CI skips strict bundle guard |
| **C** Three-tier model is real | `3776255`, `bfa1e89`, `0fb1d4b`, `docs/architecture/runtime-estates.md` | `src/main.ts`, `src/telemetry/*`, `qa/harness/*`, `esbuild.config.mjs` | **HIGH** | Bundle independence; mutable handle audit; Puppeteer absent from release | See final report §C | Runtime bundles split; compile-time coupling via `vaultSync`→`flightEvents`; Observer gets mutable handles; debug-on load failure blocks sync |
| **D** TraceSink decouples product from diagnostics | `38cc986`, `07dc22c`, `9c7e898`, `90f7183` | `src/observability/*`, `src/telemetry/debug/flightTraceSink.ts`, `main.ts`, `reconciliationController.ts` | **MEDIUM** | FLIGHT_KIND import grep; drop behavior; product dependency on traces | See final report §D | Partial migration; `vaultSync.ts` still imports `FLIGHT_KIND`; silent drops counted only in adapter |
| **E** Telemetry bundle split is safe | `3776255`, `6ed7c2f`, `47a8c66`, `release.yml` | `src/main.ts`, `installTelemetryRuntime.ts`, `esbuild.config.mjs`, `manifest.json` | **HIGH** | Missing/corrupt telemetry failure modes; mobile; version handshake | See final report §E | Split ships; no try/catch on load; `new Function` eval; no failure-mode integration tests |
| **F** Schema regression impossible | `7b11851`, `18aab6e`, `scripts/guard-schema-version.mjs` | `src/sync/schema.ts`, `vaultSync.ts`, `server/src/version.ts` | **LOW** | Guard in regressions; intentional break test | See final report §F | Guard passes; fails on v2 scratch; narrow (export inline only) |
| **G** Canonical path identity improved | `df4d0ee`, `4128476` | `src/paths/canonicalPath.ts`, `renameAdmissionPolicy.ts`, `pathCollision.ts` | **MEDIUM** | Admission-only use; NFC/NFD; collision enforcement | See final report §G | Primitive sound; collision detection unused; dual normalization (NFC vs Obsidian normPath) |
| **H** Open s01 bugs are harness not engine | `0484f21`, qa harness commits | `qa/harness/qaDebugApi.ts`, `qa/obsidian-harness/*`, `serverAckTracker.ts` | **MEDIUM** | Receipt wait semantics; openFile attribution | See final report §H | Receipt wait polls current state; fallback can false-pass; file open is harness-only |

## Behavior-Moving Commits (red flags)

| Commit | Flag | Reason |
|---|---|---|
| `4128476` extract rename admission | **Runtime semantics** | 9-case category matrix replaces binary syncable/excluded |
| `0a50776` baseline advancement | **Wiring** | Indirection through policy; must preserve hash authority |
| `a6f2080` closed-file planner | **Wiring risk** | Open/bound authoritative paths no longer flushed (regression) |
| `3776255` / `6ed7c2f` telemetry split | **Startup path** | Uncaught telemetry load when debug on |
| `18aab6e` schema v3 restore | **Product semantics** | Restores lost sync behavior (bugfix, not pure move) |
| `6d779e6` EngineControlPort DCE | **Build output** | Production vs QA product divergence by design |

## File Classification (changed files, multi-category = high risk)

| Category | Count | Notable paths |
|---|---|---|
| SYNC_ENGINE | 18 | `main.ts`, `vaultSync.ts`, `reconciliationController.ts`, `diskMirror.ts`, `editorBinding.ts` |
| RECONCILE_POLICY | 6 | `src/runtime/reconcile/*`, `renameAdmissionPolicy.ts` |
| OBSERVABILITY | 8 | `src/observability/*` |
| TELEMETRY_LOADER | 12 | `src/telemetry/*`, deleted `src/debug/*` |
| QA_HARNESS | 80+ | `qa/harness/*`, `qa/obsidian-harness/*`, `qa/controllers/*` |
| BUILD_RELEASE | 4 | `esbuild.config.mjs`, `package.json`, `.github/workflows/release.yml`, `.gitignore` |
| GUARD_TOOLING | 5 | `scripts/guard-*.mjs`, `scripts/lint-*.mjs` |
| DOCS | 3 | `docs/archive/autophagy-plan.md`, `docs/architecture/runtime-estates.md`, `docs/engineering/schema-version-guard.md` |
| TESTS | 30+ | `tests/*-policy.ts`, `tests/trace-sink.ts`, etc. |
| DELETION | 3 | `src/debug/flightEmitter.ts`, `src/lab/` (removed), legacy rename API |

**Multi-category (extra scrutiny):**

| File | Categories |
|---|---|
| `esbuild.config.mjs` | BUILD_RELEASE + QA_HARNESS + TELEMETRY_LOADER |
| `src/main.ts` | SYNC_ENGINE + OBSERVABILITY + TELEMETRY_LOADER + QA_BOUNDARY |
| `src/runtime/reconciliationController.ts` | SYNC_ENGINE + RECONCILE_POLICY + OBSERVABILITY |
| `package.json` | BUILD_RELEASE + GUARD_TOOLING + QA_HARNESS |
