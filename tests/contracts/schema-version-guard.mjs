#!/usr/bin/env node
/**
 * Regression coverage for scripts/guard-schema-version.mjs.
 *
 * The server schema pin is a release compatibility contract: min and max must
 * both equal the plugin's SCHEMA_VERSION, because admission is an equality
 * test. This test runs the real guard against otherwise-valid temporary
 * fixtures that (1) omit server/src/version.ts entirely and (2) declare a
 * min..max *range*, proving the guard fails closed in both cases.
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guardPath = resolve(root, "scripts/guard-schema-version.mjs");

function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "yaos-schema-version-guard-"));
	mkdirSync(join(dir, "src/sync"), { recursive: true });
	writeFileSync(join(dir, "src/sync/schema.ts"), "export const SCHEMA_VERSION = 3;\n");
	writeFileSync(
		join(dir, "src/sync/vaultSync.ts"),
		'import { SCHEMA_VERSION } from "./schema";\nvoid SCHEMA_VERSION;\n',
	);
	return dir;
}

function runGuard(cwd) {
	return spawnSync(process.execPath, [guardPath], { cwd, encoding: "utf8" });
}

console.log("\n--- Test 1: missing server schema contract fails closed ---");
{
	const fixtureDir = makeFixture();
	try {
		const result = runGuard(fixtureDir);

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
}

console.log("\n--- Test 2: a min..max schema range fails closed ---");
{
	const fixtureDir = makeFixture();
	try {
		mkdirSync(join(fixtureDir, "server/src"), { recursive: true });
		writeFileSync(
			join(fixtureDir, "server/src/version.ts"),
			"export const SERVER_MIN_SCHEMA_VERSION = 1;\nexport const SERVER_MAX_SCHEMA_VERSION = 3;\n",
		);

		const result = runGuard(fixtureDir);

		assert(result.status === 1, "guard exits non-zero when the server declares a schema range");
		assert(
			result.stderr.includes("must pin a single schema version"),
			"guard reports the range as a pin violation",
		);
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
}

console.log("\n--- Test 3: min === max === plugin schema passes ---");
{
	const fixtureDir = makeFixture();
	try {
		mkdirSync(join(fixtureDir, "server/src"), { recursive: true });
		writeFileSync(
			join(fixtureDir, "server/src/version.ts"),
			"export const SERVER_MIN_SCHEMA_VERSION = 3;\nexport const SERVER_MAX_SCHEMA_VERSION = 3;\n",
		);

		const result = runGuard(fixtureDir);

		assert(result.status === 0, "guard accepts a single pinned schema version");
		assert(
			result.stdout.includes("PASS: schema version guard — all checks passed."),
			"guard reports overall success for a correctly pinned server",
		);
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
