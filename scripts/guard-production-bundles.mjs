#!/usr/bin/env node

/**
 * guard-production-bundles.mjs
 *
 * Verifies that the production bundle (main.js) does not contain symbols that
 * violate the product/QA split.
 *
 * Run after build:
 *   node scripts/guard-production-bundles.mjs          # strict (default)
 *   node scripts/guard-production-bundles.mjs --transitional  # warn on transitional seams
 *
 * == Modes ==
 *
 *   strict (default, used in CI):
 *     Fails if any forbidden symbol is found, including the known-transitional
 *     seams listed in MAIN_FORBIDDEN_DEFERRED.
 *
 *   transitional (--transitional flag):
 *     Fails on hard-forbidden symbols. Warns on transitional seams.
 *     Use locally when working on changes that should not require fixing
 *     transitional seams first.
 *
 * == Architecture ==
 *
 *   main.js            = The whole product. Sync engine plus the debug runtime
 *                        (flight recorder, diagnostics), which is inert unless
 *                        the `debug` setting is on. Shipped to users.
 *                        Must NOT contain Puppeteer/mutation harness code or
 *                        Engine control capabilities.
 *
 *   qa/obsidian-harness/product-main.js
 *                      = QA-enabled product build. NOT a release artifact.
 *                        Built with __YAOS_QA_HARNESS_ENABLED__=true.
 *                        May contain Engine control capabilities.
 *
 *   qa/                = Puppeteer harness only. Not shipped.
 *                        May contain dangerous names.
 *
 * == The debug runtime is no longer a separate bundle ==
 *
 * The debug runtime used to be a second bundle, loaded by eval, and this guard
 * banned FlightRecorder/FlightTraceController/FlightTraceSink/
 * PersistentTraceLogger from main.js to prove the split held. That premise is
 * dead: those implementations now ship inside main.js by design, so banning
 * them would fail every build. What was enforced against the old debug bundle
 * — no mutation harness, no scenario steppers, no unsafe CRDT/sync — is now
 * enforced against main.js, because that code lives here.
 *
 * The debug runtime's read-only boundary is a type, not a bundle: main.ts
 * hands it a SyncReadPort (scalars + read methods), never VaultSync and never
 * a Yjs handle. That is checked by tsc, not by this script. This script only
 * proves that shippable output contains no QA/mutation capability.
 *
 * == P2 complete: __qaOnly / Unsafe / ForceSync seams removed ==
 *
 * All six __qaOnly*Unsafe methods were removed from src/ in P2 and replaced
 * with injected ports (DiskIngestPort, BindingPropagationGate).
 * MAIN_FORBIDDEN_DEFERRED retains these strings as a permanent regression guard
 * so they can never be re-introduced.
 *
 * == P3 complete: Engine control capabilities removed from production bundle ==
 *
 * getEngineControlPort and the four Engine control capability methods are now
 * gated behind __YAOS_QA_HARNESS_ENABLED__ (esbuild define, false in production).
 * Dead-code elimination removes them entirely from main.js.
 * MAIN_FORBIDDEN bans them permanently so they cannot re-enter the product bundle.
 *
 * Do NOT add new entries to MAIN_FORBIDDEN_DEFERRED without explicit sign-off.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TRANSITIONAL = process.argv.includes("--transitional");

// ---------------------------------------------------------------------------
// main.js — the shipped product bundle. Must not contain QA/Puppeteer mutation
// machinery or Engine control capabilities. The debug runtime itself is
// expected here; its own implementation names are therefore NOT banned.
// ---------------------------------------------------------------------------

const MAIN_FORBIDDEN = [
	// QA-only flight trace command ids. These exist solely in qa/harness and
	// qa/obsidian-harness; the product's own export entry point is
	// exportDebugTrace, which legitimately ships.
	"startQaFlightTrace",
	"stopQaFlightTrace",
	// Mutation harness — was enforced against the old debug bundle, now here.
	"VfsTorture",
	"vfsTorture",
	"setScenarioRunId",
	"advanceScenarioStep",
	"PauseEditorBinding",
	"pauseEditorBinding",
	"unsafe-local",
	// Force operations
	"ForceCrdt",
	"forceCrdt",
	// Engine control capabilities — must never ship in production bundle.
	// Production builds use __YAOS_QA_HARNESS_ENABLED__=false (esbuild define),
	// which dead-code-eliminates these. QA builds use product-main.js instead.
	//
	// NOTE: `ingestDiskFileNow` is intentionally NOT listed here — it is a method
	// name on DiskIngestPort, an internal interface legitimately present inside
	// ReconciliationController.  The dangerous public accessor was `getEngineControlPort`,
	// which IS banned below.  Without getEngineControlPort, the internal
	// DiskIngestPort is unreachable from outside.
	"getEngineControlPort",
	"pauseEditorPropagation",
	"resumeEditorPropagation",
	"setExternalEditPolicyOverride",
	"setQaNetworkHold",
	"networkHold",
];

// P2 regression guard — these seams were removed in P2 and must never return.
// In strict mode these FAIL. In transitional mode these WARN.
const MAIN_FORBIDDEN_DEFERRED = [
	"ForceSync",   // was: __qaOnlyForceSyncFileFromDiskUnsafe
	"Unsafe",      // was: all __qaOnly*Unsafe methods
	"__qaOnly",    // was: all __qaOnly methods
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const BUNDLE = "main.js";

function checkProductBundle() {
	if (!existsSync(BUNDLE)) {
		console.error(`FAIL [${BUNDLE}]: bundle not found at ${BUNDLE}`);
		console.error("  Run 'npm run build' first.");
		return 1;
	}
	const content = readFileSync(BUNDLE, "utf8");
	const violations = MAIN_FORBIDDEN.filter((s) => content.includes(s));
	const deferredHits = MAIN_FORBIDDEN_DEFERRED.filter((s) => content.includes(s));

	if (violations.length > 0) {
		console.error(`FAIL [${BUNDLE}]: forbidden symbols found:`);
		violations.forEach((v) => console.error(`  - ${v}`));
	}

	if (deferredHits.length > 0) {
		if (TRANSITIONAL) {
			console.warn(`WARN [${BUNDLE}]: transitional symbols present (P2 regression guard):`);
			deferredHits.forEach((v) => console.warn(`  - ${v}`));
		} else {
			console.error(`FAIL [${BUNDLE}]: P2 regression guard — symbols must not re-enter bundle:`);
			deferredHits.forEach((v) => console.error(`  - ${v}  (P2 regression guard — see guard script header)`));
		}
	}

	const totalFail = violations.length + (TRANSITIONAL ? 0 : deferredHits.length);
	if (totalFail > 0) return totalFail;

	const sizeKb = (content.length / 1024).toFixed(1);
	const note = deferredHits.length > 0 ? ` [${deferredHits.length} transitional symbol(s) present]` : "";
	console.log(`PASS [${BUNDLE}] (${sizeKb} KB)${note}`);
	return 0;
}

// ---------------------------------------------------------------------------
// src/ → qa/ isolation
// ---------------------------------------------------------------------------

const SRC_QA_IMPORT_PATTERNS = [
	/from\s+["'][^"']*\/qa\//,
	/from\s+["']\.\.\/qa\//,
	/from\s+["']\.\.\/\.\.\/qa\//,
];

function scanSrcForQaImports(dir) {
	let count = 0;
	let entries;
	try { entries = readdirSync(dir); } catch { return 0; }
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		let st;
		try { st = statSync(fullPath); } catch { continue; }
		if (st.isDirectory()) {
			count += scanSrcForQaImports(fullPath);
		} else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
			const rel = relative(".", fullPath);
			let src;
			try { src = readFileSync(fullPath, "utf8"); } catch { continue; }
			for (const pat of SRC_QA_IMPORT_PATTERNS) {
				const m = src.match(pat);
				if (m) {
					console.error(`FAIL [src->qa import]: ${rel}: ${m[0]}`);
					count++;
				}
			}
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let failures = 0;

if (TRANSITIONAL) {
	console.log("Mode: transitional (P2 regression seams warn, not fail)\n");
}

failures += checkProductBundle();

const srcQaViolations = scanSrcForQaImports("src");
if (srcQaViolations > 0) {
	console.error(`FAIL: ${srcQaViolations} src/ → qa/ import violation(s). src/ must not import from qa/.`);
	failures += srcQaViolations;
} else {
	console.log("PASS [src->qa isolation]: src/ does not import from qa/.");
}

if (failures > 0) {
	console.error(`\nFAIL: ${failures} production bundle violation(s).`);
	process.exit(1);
} else if (TRANSITIONAL) {
	console.log("\nPARTIAL PASS (transitional): product bundle clean; P2 regression symbols flagged as warnings.\nRun without --transitional to see full failure list.");
	process.exit(0);
} else {
	console.log("\nPASS: all production bundle guards passed.");
	process.exit(0);
}
