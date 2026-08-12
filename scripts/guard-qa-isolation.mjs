#!/usr/bin/env node

/**
 * guard-qa-isolation.mjs
 *
 * Verifies that src/sync/, src/runtime/, and src/telemetry/ do not import
 * QA/scenario/Puppeteer machinery directly. The fence rules:
 *
 *   Product sync/runtime code must NOT import:
 *   - qaDebugApi
 *   - YaosUnsafeQaPort
 *   - __qaOnly (as identifier)
 *   - forceCrdtContent / forceReplaceYText (from qaDebugApi context)
 *
 *   Telemetry (Observer) code must NOT import:
 *   - qaDebugApi (Puppeteer mutation API)
 *   - YaosUnsafeQaPort
 *
 * Note: installPuppeteerRuntime.ts (formerly installLabRuntime) was deleted
 * in P4A — it was a dead export with no callers. Removed from this guard.
 *
 * Allowed:
 *   - qaDebugMode (settings flag check — this gates behavior, not imports)
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const SYNC_RUNTIME_FORBIDDEN = [
	/from\s+["'].*qaDebugApi/,
	/from\s+["'].*yaosUnsafeQaPort/,
	/import.*YaosUnsafeQaPort/,
	/import.*__qaOnly/,
];

const TELEMETRY_FORBIDDEN = [
	/from\s+["'].*qaDebugApi/,
	/from\s+["'].*yaosUnsafeQaPort/,
	/import.*YaosUnsafeQaPort/,
];

// No known exceptions remain — QA offline simulation is now entirely inside
// __YAOS_QA_HARNESS_ENABLED__ blocks in main.ts and dead-code eliminated from
// production main.js. ConnectionController no longer owns QA mutation state.
const KNOWN_EXCEPTIONS = new Set([]);

let violations = 0;

function scanDir(dir, forbiddenPatterns) {
	// Fail CLOSED: if the directory we are supposed to guard does not exist,
	// that is a structural error (renamed, deleted) — not a clean pass.
	if (!existsSync(dir)) {
		console.error(`FAIL: guarded directory "${dir}" does not exist. Rename or restructure detected?`);
		violations++;
		return;
	}
	let entries;
	try {
		entries = readdirSync(dir);
	} catch (err) {
		console.error(`FAIL: could not read guarded directory "${dir}": ${err}`);
		violations++;
		return;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		let stat;
		try {
			stat = statSync(fullPath);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			scanDir(fullPath, forbiddenPatterns);
		} else if (entry.endsWith(".ts")) {
			checkFile(fullPath, forbiddenPatterns);
		}
	}
}

function checkFile(filePath, forbiddenPatterns) {
	const relPath = relative(".", filePath);
	if (KNOWN_EXCEPTIONS.has(relPath)) return;

	const content = readFileSync(filePath, "utf8");
	for (const pattern of forbiddenPatterns) {
		const match = content.match(pattern);
		if (match) {
			console.error(`FAIL: ${relPath} contains forbidden QA import: ${match[0]}`);
			violations++;
		}
	}
}

scanDir("src/sync", SYNC_RUNTIME_FORBIDDEN);
scanDir("src/runtime", SYNC_RUNTIME_FORBIDDEN);
scanDir("src/telemetry", TELEMETRY_FORBIDDEN);

if (violations > 0) {
	console.error(`\nFAIL: ${violations} QA isolation violation(s).`);
	console.error("  src/sync/ and src/runtime/ must not import QA machinery.");
	console.error("  src/telemetry/ must not import Puppeteer/mutation harness.");
	process.exit(1);
} else {
	console.log("PASS: src/sync/, src/runtime/, and src/telemetry/ are QA-isolated.");
}
