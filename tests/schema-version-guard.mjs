#!/usr/bin/env node
/**
 * Regression coverage for scripts/guard-schema-version.mjs.
 *
 * The server schema range is a release compatibility contract. This test runs
 * the real guard in an otherwise-valid temporary fixture that intentionally
 * omits server/src/version.ts, proving the guard fails closed.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;

function assert(condition, message) {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = resolve(root, "scripts/guard-schema-version.mjs");
const fixtureDir = mkdtempSync(join(tmpdir(), "yaos-schema-version-guard-"));

console.log("\n--- Test 1: missing server schema contract fails closed ---");
try {
	mkdirSync(join(fixtureDir, "src/sync"), { recursive: true });
	writeFileSync(
		join(fixtureDir, "src/sync/schema.ts"),
		"export const SCHEMA_VERSION = 3;\n",
	);
	writeFileSync(
		join(fixtureDir, "src/sync/vaultSync.ts"),
		'import { SCHEMA_VERSION } from "./schema";\nvoid SCHEMA_VERSION;\n',
	);

	const result = spawnSync(process.execPath, [guardPath], {
		cwd: fixtureDir,
		encoding: "utf8",
	});

	assert(result.status === 1, "guard exits non-zero when server/src/version.ts is absent");
	assert(
		result.stderr.includes("FAIL: server/src/version.ts is missing"),
		"guard reports the missing server schema contract",
	);
	assert(
		result.stderr.includes("FAIL: 1 schema-version guard violation(s)."),
		"guard emits its aggregate failure summary",
	);
	assert(
		!result.stdout.includes("PASS: schema version guard — all checks passed."),
		"guard never reports a missing server contract as a successful validation",
	);
} finally {
	rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
