# QA vault preparation

Create a fixture vault only at a brand-new directory:

```sh
npm run build:qa-product
npm run build:harness
npm run qa:prepare --fixture 001-basic-markdown --dest /absolute/path/to/new-qa-vault --preset minimal
```

`--dest`'s parent must already exist. The final destination must not exist: an existing empty directory, non-empty directory, regular file, or symlink (including a dangling symlink) is rejected. `qa:prepare` never recursively deletes, merges into, or overwrites a destination; `--clean` is explicitly rejected. Parents and unrelated siblings are never modified.

Fixture IDs are direct known directory names beneath `qa/fixtures/vaults`; path-like values and traversal are rejected. The command preflights the QA product/harness artifacts, manifests, plugin lock, and workspace template before it creates the destination.

The generated `.obsidian/community-plugins.json` is always ordered `yaos`, then `yaos-qa-harness`. Each preparation receives a fresh random YAOS `vaultId`, so separately prepared vaults do **not** share a sync room accidentally. For an intentional multi-device run, set the same explicit YAOS connection and vault identity only after preparation, using the run's controlled setup procedure.

Presets currently list manual community-plugin prerequisites from `qa/plugin-lock.json`; this command does not download or install them. Their versions are minimum-version reminders, not a reproducible third-party artifact lock.

## Workspace template and live acceptance

`qa/scripts/blank-workspace.json` is a checked-in, byte-stable template copied verbatim to `.obsidian/workspace.json`. It contains an empty `lastOpenFiles` array and no markdown leaf, file path, active markdown state, or vault-specific path. Regression tests check those properties and the exact output bytes.

This JSON has **not** been live-validated as an Obsidian workspace-schema contract. Before treating it as accepted for a supported Obsidian release, perform a live Obsidian/CDP acceptance run: open a newly prepared vault, wait for startup, and verify through CDP that no markdown file was restored or made active and that no recent-file state was restored. The hermetic preparation tests do not substitute for that live acceptance.

## Scope boundary

These guarantees apply only to vaults created by `qa:prepare`. A manual controller attaching to an arbitrary existing live vault remains unsafe and is not covered by preparation guarantees. This track deliberately does not add controller unsafe-attach fencing.
