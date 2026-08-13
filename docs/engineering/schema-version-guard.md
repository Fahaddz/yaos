# Schema Version Guard

## What the guard does

`scripts/guard-schema-version.mjs` runs 6 checks to prevent the P1 regression
where `src/sync/schema.ts` was deleted and `SCHEMA_VERSION` was re-inlined as a
literal `2` directly in `vaultSync.ts`:

| # | Check | Failure condition |
|---|-------|-------------------|
| 1 | `src/sync/schema.ts` exists | File deleted by a future refactor |
| 2 | `src/sync/vaultSync.ts` imports from `"./schema"` | Import removed or path changed |
| 3 | `vaultSync.ts` does NOT contain `export const SCHEMA_VERSION = N` | Constant re-inlined as a literal |
| 4 | `SCHEMA_VERSION` value in `schema.ts` equals `EXPECTED_SCHEMA_VERSION` | Version bumped in source but guard not updated, or vice versa |
| 5 | `server/src/version.ts` exists | Server contract deleted. This is a hard failure, never a warning: that file is the only place the admitted schema version is declared to clients |
| 6 | `SERVER_SCHEMA_VERSION === EXPECTED_SCHEMA_VERSION` | Server and plugin disagree |

The guard exits non-zero if any check fails and prints `FAIL: <reason>` for
each violation.

### There is no supported range

The server admits exactly one schema version. WebSocket admission in
`server/src/routes/syncSocket.ts` is an equality test against that single value,
and a client that declares no schema at all is rejected outright. The published
`schemaVersion` field in `/api/capabilities` carries that one number so the
plugin can tell the user *which* side is out of date. Check 6 is what stops the
server pin and the plugin from drifting apart.

---

## When to update the guard

Update the guard when:

- The schema version is bumped (e.g. v3 → v4).
- `src/sync/schema.ts` is moved or renamed.
- `vaultSync.ts` is renamed or its import path changes.
- `server/src/version.ts` constants are renamed.

Do NOT change `EXPECTED_SCHEMA_VERSION` in the guard before the corresponding
source files are updated — the guard will fail immediately and correctly.

---

## Step-by-step update procedure (v3 → v4 example)

Perform the following changes. Order matters: update source files first, then
the guard constant, then verify.

### 1. `src/sync/schema.ts`

Find:
```
export const SCHEMA_VERSION = 3;
```
Set to:
```
export const SCHEMA_VERSION = 4;
```

### 2. `server/src/version.ts`

Find:
```
SERVER_SCHEMA_VERSION = 3
```
Set to:
```
SERVER_SCHEMA_VERSION = 4
```

The constant must always equal the plugin's `SCHEMA_VERSION`. Setting it to a
different value is a guard failure, not a transition window: an older client is
refused at admission with `update_required`, so the upgrade path is "redeploy
the server and update the plugin", never "run a mixed fleet".

### 3. `scripts/guard-schema-version.mjs`

Find:
```
const EXPECTED_SCHEMA_VERSION = 3;
```
Set to:
```
const EXPECTED_SCHEMA_VERSION = 4;
```

This is the only line in the guard file that needs to change for a normal
version bump.

### Files summary

| File | Pattern to find | New value |
|------|----------------|-----------|
| `src/sync/schema.ts` | `export const SCHEMA_VERSION = 3` | `= 4` |
| `server/src/version.ts` | `SERVER_SCHEMA_VERSION = 3` | `= 4` |
| `scripts/guard-schema-version.mjs` | `EXPECTED_SCHEMA_VERSION = 3` | `= 4` |

---

## How to verify

After making the changes above, run:

```
npm run guard:schema-version
```

Expected output — all lines should be `PASS:`:

```
PASS: src/sync/schema.ts exists
PASS: src/sync/schema.ts: SCHEMA_VERSION = 4
PASS: src/sync/vaultSync.ts imports from "./schema"
PASS: src/sync/vaultSync.ts has no inlined SCHEMA_VERSION literal
PASS: server/src/version.ts pins schema v4 (SERVER_SCHEMA_VERSION === plugin SCHEMA_VERSION)

PASS: schema version guard — all checks passed.
```

The guard is also wired into the full regression suite:

```
npm run test:regressions
```

That command runs the guard against the repository and then runs
`tests/contracts/schema-version-guard.ts`, a hermetic temporary-fixture
regression. It builds fixtures containing valid plugin schema files and then, in
turn, omits `server/src/version.ts`, pins a version other than the plugin's, and
declares a correct pin. The first two must exit non-zero and the third must exit
zero. That stops the guard from silently downgrading a missing server
compatibility contract to a warning, and stops the server pin from drifting away
from the plugin.

---

## How to test that the guard catches a regression

The automated temporary-fixture regression covers the missing-server-contract
and mismatched-pin cases. To manually test the original plugin-side regression
without leaving a source edit behind:

1. In `src/sync/vaultSync.ts`, temporarily add:
   ```typescript
   export const SCHEMA_VERSION = 2; // simulated regression
   ```
2. Run `npm run guard:schema-version`.
3. Confirm output contains:
   ```
   FAIL: src/sync/vaultSync.ts contains an inlined 'export const SCHEMA_VERSION = N'
   FAIL: 1 schema-version guard violation(s).
   ```
4. Revert the temporary change.

Alternatively, temporarily set `EXPECTED_SCHEMA_VERSION` in the guard to the
wrong value and confirm checks 4 and 6 fail.
