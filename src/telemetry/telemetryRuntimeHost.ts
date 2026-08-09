/**
 * TelemetryRuntimeHost — minimal interface that main.ts exposes to the
 * telemetry runtime.
 *
 * Telemetry code accesses product state exclusively through this interface.
 * Product code never imports telemetry modules directly.
 *
 * This interface exposes only read-only / passive capabilities:
 *   - settings access
 *   - read-only product state snapshots
 *   - identity / hashing helpers
 *   - lifecycle hooks (cleanup, logging)
 *
 * FORBIDDEN in this interface:
 *   forceCrdtContent, forceSyncFileFromDisk, setScenarioRunId,
 *   advanceScenarioStep, setQaNetworkHold, pauseEditorBindingPropagation,
 *   runVfsTortureTest, anything Unsafe, anything __qaOnly
 */

import type { App } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import type { TraceSink } from "../observability/traceSink";
import type { TraceHttpContext } from "../observability/traceContext";
import type { FrontmatterQuarantineEntry } from "../sync/frontmatterQuarantine";

/**
 * Read-only snapshot of runtime state passed through to DiagnosticsService.
 * All fields are plain scalars — no object handles.
 */
export interface RuntimeDiagnosticsState {
	reconciled: boolean;
	reconcileInFlight: boolean;
	reconcilePending: boolean;
	lastReconcileStats: {
		at: string;
		mode: import("../sync/vaultSync").ReconcileMode;
		plannedCreates: number;
		plannedUpdates: number;
		flushedCreates: number;
		flushedUpdates: number;
		safetyBrakeTriggered: boolean;
		safetyBrakeReason: string | null;
	} | null;
	awaitingFirstProviderSyncAfterStartup: boolean;
	lastReconciledGeneration: number;
	untrackedFileCount: number;
	openFileCount: number;
}

/**
 * SyncReadPort — strictly read-only view of VaultSync state for Observer use.
 *
 * This replaces the broad `VaultSync` handle that was previously passed to
 * telemetry. All mutating methods (queueRename, handleDelete, ensureFile,
 * forceReplaceYText, etc.) and mutable Yjs objects (Y.Text, Y.Map) are absent.
 *
 * Enforcement: Observer code never gets a VaultSync reference; it gets this
 * interface. The type system prevents calling any method not listed here.
 */
export interface SyncReadPort {
	// ------------------------------------------------------------------
	// Connection / auth state — all readonly scalars
	// ------------------------------------------------------------------
	readonly connected: boolean;
	readonly fatalAuthError: boolean;
	readonly fatalAuthCode: string | null;
	readonly fatalAuthDetails: {
		readonly clientSchemaVersion: number | null;
		readonly roomSchemaVersion: number | null;
		readonly reason: string | null;
	} | null;
	readonly localReady: boolean;
	readonly providerSynced: boolean;
	readonly isInitialized: boolean;
	readonly connectionGeneration: number;

	// ------------------------------------------------------------------
	// Timestamp state
	// ------------------------------------------------------------------
	readonly lastLocalUpdateAt: number | null;
	readonly lastLocalUpdateWhileConnectedAt: number | null;
	readonly lastRemoteUpdateAt: number | null;

	// ------------------------------------------------------------------
	// Server receipt / ACK state
	// ------------------------------------------------------------------
	readonly serverAppliedLocalState: boolean | null;
	readonly lastServerReceiptEchoAt: number | null;
	readonly lastKnownServerReceiptEchoAt: number | null;
	readonly hasUnconfirmedServerReceiptCandidate: boolean;
	readonly serverReceiptCandidateCapturedAt: number | null;
	readonly serverReceiptStartupValidation:
		| "not_started"
		| "validated"
		| "skipped_local_yjs_timeout"
		| "unavailable";
	readonly svEchoCounters: {
		readonly customMessageSeenCount: number;
		readonly svEchoSeenCount: number;
		readonly acceptedCount: number;
		readonly rejectedCount: number;
		readonly rejectedOversizeCount: number;
		readonly rejectedInvalidCount: number;
		readonly bytesMax: number;
	};

	// ------------------------------------------------------------------
	// Persistence health
	// ------------------------------------------------------------------
	readonly candidatePersistenceHealthy: boolean | null;
	readonly candidatePersistenceFailureCount: number;
	readonly idbError: boolean;
	readonly idbErrorDetails: {
		readonly kind: string;
		readonly name: string | null;
		readonly message: string | null;
		readonly phase: "open" | "wait" | "runtime";
		readonly at: string;
	} | null;

	// ------------------------------------------------------------------
	// Schema
	// ------------------------------------------------------------------
	readonly supportedSchemaVersion: number;
	readonly storedSchemaVersion: number | null;

	// ------------------------------------------------------------------
	// Path / content reads — returns plain strings, never mutable Yjs objects
	// ------------------------------------------------------------------

	/** Returns the string content of the CRDT document at path, or null. */
	getPathContent(path: string): string | null;
	/** Returns the stable fileId for the CRDT text at path, or undefined. */
	getFileIdForPath(path: string): string | undefined;
	/** Returns true if the path has been tombstone-deleted in the CRDT. */
	isPathTombstoned(path: string): boolean;
	/** Returns a snapshot of currently active markdown paths. */
	getActiveMarkdownPaths(): readonly string[];
	/** Returns the count of blob paths. */
	readonly blobPathCount: number;
	/** Returns recent vault sync log entries. */
	getRecentEvents(limit?: number): ReadonlyArray<{ ts: string; msg: string }>;
	/** Returns the current reconcile mode. */
	getSafeReconcileMode(): import("../sync/vaultSync").ReconcileMode;

	// ------------------------------------------------------------------
	// Observer subscription (read-only: metadata change stream)
	// ------------------------------------------------------------------

	/**
	 * Subscribe to metadata changes (path renames, deletions).
	 * Returns an unsubscribe function. The Observer may only read from
	 * the batch; the callback must not mutate CRDT state.
	 */
	observeMetaChanges(callback: (batch: import("../sync/fileMeta").MetaChangeBatch) => void): () => void;

	/**
	 * Subscribe to active markdown content changes as primitive path/origin data.
	 * The Engine retains all mutable Y.Text ownership.
	 */
	observePathContentChanges(callback: (path: string, isLocal: boolean) => void): () => void;
}

export interface DiskMirrorSnapshot {
	readonly activeObserverCount: number;
}

export interface BlobSyncSnapshot {
	readonly pendingUploads: number;
	readonly pendingDownloads: number;
}

export interface EditorSampleSnapshot {
	readonly kind: "not_open" | "healthy_sampled" | "settling" | "unhealthy";
	readonly content: string | null;
}

export interface TelemetryRuntimeHost {
	// Telemetry is an Obsidian module and may use App for UI, diagnostics export,
	// and trace persistence. Domain state must still cross this boundary as values.
	readonly app: App;
	getSettings(): VaultSyncSettings;

	/**
	 * Narrow read-only view of sync state.
	 * Returns null if VaultSync has not been initialised yet.
	 *
	 * NOTE: this replaces the previous getVaultSync(): VaultSync | null handle.
	 * The Observer tier must not receive a mutable VaultSync reference.
	 */
	getSyncState(): SyncReadPort | null;

	getTraceSink(): TraceSink;
	getTraceHttpContext(): TraceHttpContext | undefined;

	// Domain diagnostics cross this boundary as scalar snapshots, never manager instances.
	getDiskMirrorSnapshot(): DiskMirrorSnapshot | null;
	getBlobSyncSnapshot(): BlobSyncSnapshot | null;
	/** Host-owned editor lookup; telemetry receives only a value sample. */
	getEditorSample(path: string): EditorSampleSnapshot;
	getEventRing(): ReadonlyArray<{ ts: string; msg: string }>;
	getRecentServerTrace(): readonly unknown[];
	getFrontmatterQuarantineEntries(): readonly FrontmatterQuarantineEntry[];
	getRuntimeDiagnosticsState(): RuntimeDiagnosticsState;
	collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>>;

	sha256Hex(text: string): Promise<string>;
	getPluginVersion(): string;
	isMarkdownPathSyncable(path: string): boolean;
	/** Register a cleanup to run on plugin unload. */
	registerCleanup(cleanup: () => void): void;
	log(msg: string): void;
}
