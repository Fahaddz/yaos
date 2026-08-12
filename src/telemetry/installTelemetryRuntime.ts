/**
 * installTelemetryRuntime — wires passive Observer machinery given a
 * TelemetryRuntimeHost.
 *
 * This is the single entry point for the telemetry/observer runtime.
 * main.ts imports this ONLY via dynamic import when settings.debug or
 * settings.qaDebugMode is true. In a production build with code splitting
 * this file and all its transitive imports stay out of the main chunk.
 *
 * Observer contract:
 *   - May contain: FlightRecorder, SafeDiagnostics,
 *     FlightTraceSink / recorder adapter, redaction/path hashing,
 *     safe support bundle export, passive trace recording.
 *   - Must NOT: mutate sync state, CRDT state, editor state, network state,
 *     or the filesystem except for safe export/write-to-user-approved channels.
 *   - Must NOT: contain VFS torture, scenario steppers, unsafe CRDT forcing,
 *     forced sync, network holds, or editor-pause controls.
 *
 * Mutation harness (Puppeteer) lives in qa/ and is never imported from here.
 */

import type { App, Plugin } from "obsidian";
import { Notice } from "obsidian";
import type { TelemetryRuntimeHost } from "./telemetryRuntimeHost";
import { FlightTraceController } from "./debug/flightTraceController";
import { FlightTraceSink } from "./debug/flightTraceSink";
import { DiagnosticsService } from "./diagnostics/diagnosticsService";
import type { FlightMode, FlightPathEventInput, FlightEventInput } from "./debug/flightEvents";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import { PersistentTraceLogger } from "./debug/trace";
import type { TraceLoggerPort, TraceLoggerConfig } from "../observability/traceLogger";
export { TELEMETRY_RUNTIME_ABI_VERSION as telemetryRuntimeAbiVersion } from "./telemetryRuntimeAbi";

/**
 * Handle returned to main.ts after telemetry runtime is installed.
 * All methods use primitive types only — no telemetry types leak through.
 *
 * This interface contains ONLY passive/observer capabilities.
 * FORBIDDEN: forceCrdtContent, forceSyncFileFromDisk, setQaNetworkHold,
 *   pauseEditorBindingPropagation, runVfsTortureTest, anything Unsafe,
 *   anything __qaOnly.
 */
export interface TelemetryRuntimeHandle {
	// TraceSink adapter — product code routes events here
	readonly traceSink: import("../observability/traceSink").TraceSink;

	// Called by main.ts on every path event (from reconciliation, sync)
	recordFlightPathEvent(event: ProductFlightPathEventInput | FlightPathEventInput): void;
	recordFlightEvent(event: FlightEventInput): void;

	// Flight trace lifecycle
	setupFlightTrace(deps: {
		getDocSchemaVersion(): number | null;
		buildCheckpoint(): Promise<Record<string, unknown>>;
	}): void;
	refreshFlightTraceState(reason: string): Promise<void>;
	scheduleTraceStateSnapshot(reason: string): void;

	// Passive trace commands (safe, read-only diagnostic operations)
	startTelemetryTrace(mode?: string): Promise<void>;
	stopTelemetryTrace(): Promise<void>;
	exportSafeFlightTrace(): Promise<void>;
	exportFullFlightTrace(): Promise<void>;
	showTimelineForCurrentFile(): void;
	clearFlightLogs(): Promise<void>;

	// QA trace secret hash (for cross-device identity verification — read-only)
	getQaTraceSecretHash(): string | null;

	// ---------------------------------------------------------------------------
	// QA harness accessors — read-only references to internal Observer objects.
	// Used by qa/obsidian-harness/ to assemble window.__YAOS_DEBUG__.
	// Optional so existing callers are unaffected.
	// ---------------------------------------------------------------------------

	/** Returns the FlightTraceController instance (for QA harness phase recording). */
	getFlightTraceController?(): import("./debug/flightTraceController").FlightTraceController | null;

	// Diagnostics — typed as unknown to avoid nominal type mismatch between
	// src/telemetry/diagnostics/diagnosticsService and src/diagnostics/diagnosticsService.
	// They are structurally identical; call sites cast as needed.
	readonly diagnosticsService: unknown;

	// Called on plugin unload
	dispose(): void;

	/** Creates a PersistentTraceLogger bound to the telemetry runtime. */
	createTraceLogger(app: App, config: TraceLoggerConfig): TraceLoggerPort;

	/**
	 * Register all telemetry commands with the plugin.
	 * Called once during initSync, after product commands are registered.
	 * Telemetry owns: passive trace commands, safe trace export, log clearing.
	 */
	registerCommands(plugin: Pick<Plugin, "addCommand">): void;
}

export async function installTelemetryRuntime(host: TelemetryRuntimeHost): Promise<TelemetryRuntimeHandle> {
	let flightTrace: FlightTraceController | null = null;
	let _qaTraceSecretHash: string | null = null;

	// -----------------------------------------------------------------------
	// DiagnosticsService
	// -----------------------------------------------------------------------

	const diagnosticsService = new DiagnosticsService({
		app: host.app,
		getSettings: () => host.getSettings(),
		getSyncState: () => host.getSyncState(),
		getDiskMirrorSnapshot: () => host.getDiskMirrorSnapshot(),
		getBlobSyncSnapshot: () => host.getBlobSyncSnapshot(),
		getTraceHttpContext: () => host.getTraceHttpContext(),
		getEventRing: () => host.getEventRing() as Array<{ ts: string; msg: string }>,
		getRecentServerTrace: () => host.getRecentServerTrace() as unknown[],
		getFrontmatterQuarantineEntries: () => host.getFrontmatterQuarantineEntries() as import("../sync/frontmatterQuarantine").FrontmatterQuarantineEntry[],
		getState: () => host.getRuntimeDiagnosticsState(),
		isMarkdownPathSyncable: (path) => host.isMarkdownPathSyncable(path),
		collectOpenFileTraceState: () => host.collectOpenFileTraceState(),
		sha256Hex: (text) => host.sha256Hex(text),
		log: (message) => host.log(message),
	});

	// -----------------------------------------------------------------------
	// TraceSink (FlightTraceSink adapter)
	// -----------------------------------------------------------------------

	const traceSink = new FlightTraceSink((event) => handle.recordFlightPathEvent(event));

	// -----------------------------------------------------------------------
	// recordFlightPathEvent — core routing logic (passive event routing)
	// -----------------------------------------------------------------------

	function recordFlightPathEvent(event: ProductFlightPathEventInput | FlightPathEventInput): void {
		const admissionKinds = new Set([
			"crdt.file.created",
			"crdt.file.renamed",
			"crdt.file.revived",
		]);
		const isAdmissionOrRenameTarget =
			admissionKinds.has(event.kind) ||
			(event.kind === "disk.rename.observed" &&
				event.data?.renameRole === "target");

		if (isAdmissionOrRenameTarget) {
			const excludedByPolicy = !host.isMarkdownPathSyncable(event.path);
			event = {
				...event,
				data: {
					...(event.data ?? {}),
					excludedByPolicy,
				},
			};
		}

		void flightTrace?.recordPath(event);
	}

	// -----------------------------------------------------------------------
	// Telemetry / trace commands (passive, safe)
	// -----------------------------------------------------------------------

	async function startTelemetryTrace(mode?: string): Promise<void> {
		const resolved = (mode ?? host.getSettings().qaTraceMode) as FlightMode;
		await flightTrace?.start(resolved, host.getSettings().qaTraceSecret || null, {
			manualStart: true,
		});
		const secret = host.getSettings().qaTraceSecret ?? "";
		try {
			const bytes = new TextEncoder().encode(`yaos-qa-trace-secret:${secret}`);
			const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
			const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
			_qaTraceSecretHash = `sha256:${hex}`;
		} catch {
			_qaTraceSecretHash = `len:${secret.length}`;
		}
		new Notice(`Telemetry trace started (mode: ${resolved}).`, 4000);
	}

	async function stopTelemetryTrace(): Promise<void> {
		await flightTrace?.stop();
		new Notice("Telemetry trace stopped.", 4000);
	}

	async function exportFlightTrace(requestedPrivacy: "safe" | "full"): Promise<void> {
		const controller = flightTrace;
		if (!controller) {
			new Notice("No active flight trace to export.", 4000);
			return;
		}
		const diagDir = await diagnosticsService.ensureDiagnosticsDir().catch(() => null);
		if (!diagDir) {
			new Notice("Could not resolve diagnostics directory.", 4000);
			return;
		}
		const result = await controller.exportTrace({ requestedPrivacy: requestedPrivacy, diagDir });
		if (result.ok) {
			new Notice(`Flight trace exported: ${result.path}`, 6000);
		} else {
			new Notice(`Export failed: ${result.reason}`, 6000);
		}
	}

	// -----------------------------------------------------------------------
	// FlightTrace setup
	// -----------------------------------------------------------------------

	function setupFlightTrace(deps: {
		getDocSchemaVersion(): number | null;
		buildCheckpoint(): Promise<Record<string, unknown>>;
	}): void {
		flightTrace = new FlightTraceController({
			app: host.app,
			getSettings: () => host.getSettings(),
			getPluginVersion: () => host.getPluginVersion(),
			getDocSchemaVersion: () => deps.getDocSchemaVersion(),
			buildCheckpoint: () => deps.buildCheckpoint(),
			registerCleanup: (cleanup) => host.registerCleanup(cleanup),
			log: (message) => host.log(message),
		});
	}

	async function refreshFlightTraceState(reason: string): Promise<void> {
		await flightTrace?.refreshFromSettings(reason);
	}

	function scheduleTraceStateSnapshot(reason: string): void {
		// No-op: snapshot scheduling happens internally in FlightTraceController
		void reason;
	}

	// -----------------------------------------------------------------------
	// Dispose
	// -----------------------------------------------------------------------

	function dispose(): void {
		void flightTrace?.stop();   // flush/stop flight trace on unload (fire-and-forget)
	}

	// -----------------------------------------------------------------------
	// registerCommands — passive telemetry command surface only
	//
	// Allowed: enable/start passive trace, stop passive trace, export safe
	// telemetry trace, show recent telemetry state, clear telemetry logs.
	//
	// Forbidden: run VFS torture, force CRDT, force sync, pause editor
	// binding, unsafe-local export, network hold / offline hold controls.
	// -----------------------------------------------------------------------

	function registerTelemetryCommands(plugin: Pick<Plugin, "addCommand">): void {
		// Passive flight trace commands
		plugin.addCommand({
			id: "telemetry-trace-start",
			name: "Start telemetry trace",
			callback: () => { void startTelemetryTrace(); },
		});
		plugin.addCommand({
			id: "telemetry-trace-stop",
			name: "Stop telemetry trace",
			callback: () => { void stopTelemetryTrace(); },
		});
		plugin.addCommand({
			id: "telemetry-trace-export-safe",
			name: "Export safe telemetry trace",
			callback: () => { void exportFlightTrace("safe"); },
		});
		plugin.addCommand({
			id: "telemetry-trace-export-full",
			name: "Export telemetry trace with filenames",
			callback: () => { void exportFlightTrace("full"); },
		});
		plugin.addCommand({
			id: "telemetry-trace-timeline-current-file",
			name: "Show timeline for current file",
			callback: () => { new Notice("Timeline view not yet implemented in telemetry runtime.", 4000); },
		});
		plugin.addCommand({
			id: "telemetry-trace-clear-logs",
			name: "Clear telemetry logs",
			callback: () => {
				void (flightTrace?.clearLogs() ?? Promise.resolve()).then(() => {
					new Notice("Telemetry logs cleared.", 4000);
				});
			},
		});
	}

	// -----------------------------------------------------------------------
	// Handle
	// -----------------------------------------------------------------------

	const handle: TelemetryRuntimeHandle = {
		traceSink,
		recordFlightPathEvent,
		recordFlightEvent(event) {
			flightTrace?.record(event);
		},
		setupFlightTrace,
		refreshFlightTraceState,
		scheduleTraceStateSnapshot,
		startTelemetryTrace,
		stopTelemetryTrace,
		exportSafeFlightTrace: () => exportFlightTrace("safe"),
		exportFullFlightTrace: () => exportFlightTrace("full"),
		showTimelineForCurrentFile() {
			new Notice("Timeline view not yet implemented in telemetry runtime.", 4000);
		},
		clearFlightLogs: () => flightTrace?.clearLogs() ?? Promise.resolve(),
		getQaTraceSecretHash(): string | null {
			return _qaTraceSecretHash;
		},
		getFlightTraceController: () => flightTrace,
		diagnosticsService,
		dispose,
		createTraceLogger(app: App, config: TraceLoggerConfig): TraceLoggerPort {
			return new PersistentTraceLogger(app, config);
		},
		registerCommands: registerTelemetryCommands,
	};

	return handle;
}
