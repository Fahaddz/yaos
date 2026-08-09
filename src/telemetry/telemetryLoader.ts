/**
 * telemetryLoader — isolated loader for the telemetry.js bundle.
 *
 * Owns ALL the ugliness of dynamic loading so main.ts does not have to:
 *   - platform check (desktop-only)
 *   - fs availability check
 *   - file read
 *   - new Function() eval
 *   - export shape validation
 *   - error-to-warning conversion
 *
 * Returns TelemetryRuntimeHandle on success, null on any failure.
 * NEVER throws. NEVER blocks sync startup.
 *
 * Dependency-injectable: pass readFileFn to override fs.readFileSync in tests.
 */

import type { TelemetryRuntimeHost } from "./telemetryRuntimeHost";
import type { TelemetryRuntimeHandle } from "./installTelemetryRuntime";
import { TELEMETRY_RUNTIME_ABI_VERSION } from "./telemetryRuntimeAbi";

export type TelemetryLoadResult =
	| { kind: "loaded"; runtime: TelemetryRuntimeHandle }
	| { kind: "failed"; reason: "platform-mobile" | "file-missing" | "eval-error" | "bad-export" | "abi-mismatch" | "runtime-error"; error: string };

export interface TelemetryLoaderDeps {
	/** Full path to the plugin directory (e.g. .obsidian/plugins/yaos). */
	readonly pluginDir: string;
	/**
	 * Obsidian's patched require — must be the calling module's require so that
	 * require("obsidian") inside telemetry.js resolves correctly.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly pluginRequire: any;
	/** The assembled TelemetryRuntimeHost to pass to installTelemetryRuntime. */
	readonly host: TelemetryRuntimeHost;
	/**
	 * File-read override for testing. Defaults to fs.readFileSync when absent.
	 * Tests inject a fake that throws ENOENT, returns invalid JS, etc.
	 */
	readonly readFileFn?: (path: string) => string;
	/** Optional log callback (for console.error escalation in tests). */
	readonly log?: (msg: string) => void;
}

/**
 * Load the telemetry bundle, evaluate it, and return the runtime handle.
 *
 * Failure modes:
 *   platform-mobile   — fs is not available; mobile device detected by caller.
 *   file-missing      — telemetry.js does not exist at the expected path.
 *   eval-error        — telemetry.js exists but cannot be parsed or throws on eval.
 *   bad-export        — telemetry.js evaluated but did not export installTelemetryRuntime.
 *   runtime-error     — installTelemetryRuntime threw during initialization.
 *
 * In all failure cases: returns null-equivalent result, logs to console.
 * Caller (main.ts) converts the result to a Notice if needed.
 */
export async function loadTelemetryBundle(deps: TelemetryLoaderDeps): Promise<TelemetryLoadResult> {
	const { pluginDir, pluginRequire, host, log } = deps;
	const telemetryBundlePath = `${pluginDir}/telemetry.js`;

	// Step 1: read the file
	let telemetryCode: string;
	try {
		if (deps.readFileFn) {
			telemetryCode = deps.readFileFn(telemetryBundlePath);
		} else {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const fs = pluginRequire("fs") as typeof import("fs");
			telemetryCode = fs.readFileSync(telemetryBundlePath, "utf-8");
		}
	} catch (err) {
		const msg = `[yaos/telemetry-loader] telemetry.js not found at "${telemetryBundlePath}": ${String(err)}`;
		log?.(msg);
		console.error(msg);
		return { kind: "failed", reason: "file-missing", error: String(err) };
	}

	// Step 2: evaluate the bundle via new Function (CommonJS wrapper)
	let installTelemetryRuntime: unknown;
	let telemetryRuntimeAbiVersion: unknown;
	try {
		const telemetryModule = { exports: {} as Record<string, unknown> };
		// eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
		const telemetryFn = new Function("require", "module", "exports", "__filename", "__dirname", telemetryCode);
		telemetryFn(pluginRequire, telemetryModule, telemetryModule.exports, telemetryBundlePath, pluginDir);
		installTelemetryRuntime = telemetryModule.exports.installTelemetryRuntime;
		telemetryRuntimeAbiVersion = telemetryModule.exports.telemetryRuntimeAbiVersion;
	} catch (err) {
		const msg = `[yaos/telemetry-loader] telemetry.js eval failed: ${String(err)}`;
		log?.(msg);
		console.error(msg);
		return { kind: "failed", reason: "eval-error", error: String(err) };
	}

	// Step 3: validate the exported function
	if (typeof installTelemetryRuntime !== "function") {
		const msg =
			`[yaos/telemetry-loader] telemetry.js did not export installTelemetryRuntime ` +
			`(got ${typeof installTelemetryRuntime}). The bundle may be from a different plugin version.`;
		log?.(msg);
		console.error(msg);
		return { kind: "failed", reason: "bad-export", error: msg };
	}

	// Step 4: reject a stale or incompatible telemetry.js before it can run.
	if (telemetryRuntimeAbiVersion !== TELEMETRY_RUNTIME_ABI_VERSION) {
		const actualVersion = typeof telemetryRuntimeAbiVersion === "number"
			? String(telemetryRuntimeAbiVersion)
			: telemetryRuntimeAbiVersion === undefined ? "missing" : typeof telemetryRuntimeAbiVersion;
		const msg =
			`[yaos/telemetry-loader] telemetry.js ABI mismatch: expected ${TELEMETRY_RUNTIME_ABI_VERSION}, ` +
			`got ${actualVersion}. Sync will continue without telemetry.`;
		log?.(msg);
		console.error(msg);
		return { kind: "failed", reason: "abi-mismatch", error: msg };
	}

	// Step 5: call installTelemetryRuntime with the host
	try {
		const runtime = await (installTelemetryRuntime as (host: TelemetryRuntimeHost) => Promise<TelemetryRuntimeHandle>)(host);
		return { kind: "loaded", runtime };
	} catch (err) {
		const msg = `[yaos/telemetry-loader] installTelemetryRuntime threw: ${String(err)}`;
		log?.(msg);
		console.error(msg);
		return { kind: "failed", reason: "runtime-error", error: String(err) };
	}
}
