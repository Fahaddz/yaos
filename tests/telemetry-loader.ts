/**
 * Failure-mode tests for the telemetry loader.
 *
 * These tests document the five failure scenarios the reviewer identified:
 *
 *   Scenario 1: telemetry.js missing when debug=true  => fails gracefully
 *   Scenario 2: telemetry.js malformed (invalid JS)   => fails gracefully
 *   Scenario 3: wrong export shape (no function)      => fails gracefully
 *   Scenario 4: installTelemetryRuntime throws         => fails gracefully
 *   Scenario 5: successful load                       => returns runtime handle
 *
 * All failure modes must:
 *   - Return { kind: "failed", reason: ... }
 *   - NOT throw
 *   - Allow sync to continue (caller can ignore the result and proceed)
 *
 * The "hope-shaped patch" is not enough. These tests prove the try/catch
 * and export validation work correctly under each failure mode.
 * ABI compatibility cases additionally prove a stale telemetry.js is rejected
 * before its installer can run.
 */

import { loadTelemetryBundle } from "../src/telemetry/telemetryLoader";
import type { TelemetryLoaderDeps } from "../src/telemetry/telemetryLoader";
import { TELEMETRY_RUNTIME_ABI_VERSION } from "../src/telemetry/telemetryRuntimeAbi";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

// Minimal stub host — never actually called in failure scenarios.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_HOST: any = {};

// Minimal stub require — never actually called because readFileFn is injected.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_REQUIRE: any = () => { throw new Error("require should not be called in tests"); };

function makeBaseDeps(overrides: Partial<TelemetryLoaderDeps> = {}): TelemetryLoaderDeps {
	return {
		pluginDir: "/fake/plugin/dir",
		pluginRequire: STUB_REQUIRE,
		host: STUB_HOST,
		log: () => {}, // suppress console output in test runner
		...overrides,
	};
}

// -----------------------------------------------------------------------
// Scenario 1: telemetry.js missing (readFileFn throws ENOENT-like error)
// -----------------------------------------------------------------------

console.log("\n--- Scenario 1: telemetry.js missing ---");
{
	const deps = makeBaseDeps({
		readFileFn: (_path: string) => {
			const err = new Error("ENOENT: no such file or directory");
			(err as NodeJS.ErrnoException).code = "ENOENT";
			throw err;
		},
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result (does not throw)");
	if (result.kind === "failed") {
		assert(result.reason === "file-missing", "reason is file-missing");
		assert(result.error.includes("ENOENT"), "error message includes ENOENT");
	}
}

// -----------------------------------------------------------------------
// Scenario 2: telemetry.js malformed (invalid JS / SyntaxError)
// -----------------------------------------------------------------------

console.log("\n--- Scenario 2: telemetry.js malformed (invalid JavaScript) ---");
{
	const deps = makeBaseDeps({
		readFileFn: (_path: string) => "}{this is not valid javascript }{",
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result (does not throw)");
	if (result.kind === "failed") {
		assert(result.reason === "eval-error", "reason is eval-error");
	}
}

// -----------------------------------------------------------------------
// Scenario 3: wrong export shape (exports empty object, no function)
// -----------------------------------------------------------------------

console.log("\n--- Scenario 3: wrong export shape (installTelemetryRuntime not exported) ---");
{
	// Valid JS that exports nothing useful
	const deps = makeBaseDeps({
		readFileFn: (_path: string) => `
			// Valid CommonJS module but with wrong exports
			Object.assign(exports, { someOtherFunction: function() {} });
		`,
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result (does not throw)");
	if (result.kind === "failed") {
		assert(result.reason === "bad-export", "reason is bad-export");
		assert(result.error.includes("installTelemetryRuntime"), "error mentions the missing export");
	}
}

// -----------------------------------------------------------------------
// Scenario 4: telemetry ABI is stale or absent (installer must not run)
// -----------------------------------------------------------------------

console.log("\n--- Scenario 4: telemetry ABI mismatch ---");
{
	const host = { installerCalled: false };
	const deps = makeBaseDeps({
		host,
		readFileFn: (_path: string) => `
			exports.telemetryRuntimeAbiVersion = ${TELEMETRY_RUNTIME_ABI_VERSION + 1};
			exports.installTelemetryRuntime = async function(runtimeHost) {
				runtimeHost.installerCalled = true;
				return {};
			};
		`,
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result (does not throw)");
	if (result.kind === "failed") {
		assert(result.reason === "abi-mismatch", "reason is abi-mismatch");
		assert(result.error.includes(`expected ${TELEMETRY_RUNTIME_ABI_VERSION}`), "error includes expected ABI version");
		assert(result.error.includes(`got ${TELEMETRY_RUNTIME_ABI_VERSION + 1}`), "error includes bundle ABI version");
	}
	assert(!host.installerCalled, "does not invoke an incompatible telemetry installer");
}

console.log("\n--- Scenario 4b: telemetry ABI missing ---");
{
	const host = { installerCalled: false };
	const deps = makeBaseDeps({
		host,
		readFileFn: (_path: string) => `
			exports.installTelemetryRuntime = async function(runtimeHost) {
				runtimeHost.installerCalled = true;
				return {};
			};
		`,
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result (does not throw)");
	if (result.kind === "failed") {
		assert(result.reason === "abi-mismatch", "reason is abi-mismatch when version is missing");
		assert(result.error.includes("got missing"), "error identifies the missing ABI version");
	}
	assert(!host.installerCalled, "does not invoke a telemetry installer without an ABI version");
}

// -----------------------------------------------------------------------
// Scenario 5: installTelemetryRuntime throws during initialization
// -----------------------------------------------------------------------

console.log("\n--- Scenario 5: installTelemetryRuntime throws at runtime ---");
{
	// Valid export but the function throws
	const deps = makeBaseDeps({
		readFileFn: (_path: string) => `
			exports.telemetryRuntimeAbiVersion = ${TELEMETRY_RUNTIME_ABI_VERSION};
			exports.installTelemetryRuntime = async function(host) {
				throw new Error("Simulated initialization failure: incompatible plugin version");
			};
		`,
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result (does not throw)");
	if (result.kind === "failed") {
		assert(result.reason === "runtime-error", "reason is runtime-error");
		assert(result.error.includes("incompatible plugin version"), "error propagates the thrown message");
	}
}

// -----------------------------------------------------------------------
// Scenario 6: successful load
// -----------------------------------------------------------------------

console.log("\n--- Scenario 6: successful load returns runtime handle ---");
{
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const fakeRuntime: any = {
		traceSink: { record: () => {}, recordPath: () => {} },
		recordFlightPathEvent: () => {},
		recordFlightEvent: () => {},
		dispose: () => {},
	};

	const deps = makeBaseDeps({
		readFileFn: (_path: string) => `
			exports.telemetryRuntimeAbiVersion = ${TELEMETRY_RUNTIME_ABI_VERSION};
			exports.installTelemetryRuntime = async function(host) {
				// Minimal valid runtime — enough to satisfy the loader contract
				return {
					traceSink: { record: function() {}, recordPath: function() {} },
					recordFlightPathEvent: function() {},
					recordFlightEvent: function() {},
					dispose: function() {},
				};
			};
		`,
	});
	void fakeRuntime; // suppress unused

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "loaded", "returns loaded result");
	if (result.kind === "loaded") {
		assert(typeof result.runtime === "object" && result.runtime !== null, "runtime is an object");
		assert(typeof result.runtime.traceSink === "object", "runtime has traceSink");
		assert(typeof result.runtime.dispose === "function", "runtime has dispose()");
	}
}

// -----------------------------------------------------------------------
// Scenario 7: installTelemetryRuntime export is null (edge case of bad-export)
// -----------------------------------------------------------------------

console.log("\n--- Scenario 7: installTelemetryRuntime exported as null ---");
{
	const deps = makeBaseDeps({
		readFileFn: (_path: string) => `
			exports.installTelemetryRuntime = null;
		`,
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result");
	if (result.kind === "failed") {
		assert(result.reason === "bad-export", "reason is bad-export for null");
	}
}

// -----------------------------------------------------------------------
// Scenario 8: installTelemetryRuntime exported as a number (type mismatch)
// -----------------------------------------------------------------------

console.log("\n--- Scenario 8: installTelemetryRuntime exported as wrong type (number) ---");
{
	const deps = makeBaseDeps({
		readFileFn: (_path: string) => `
			exports.installTelemetryRuntime = 42;
		`,
	});

	const result = await loadTelemetryBundle(deps);

	assert(result.kind === "failed", "returns failed result");
	if (result.kind === "failed") {
		assert(result.reason === "bad-export", "reason is bad-export for number");
	}
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
