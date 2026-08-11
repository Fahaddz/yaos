/**
 * PersistenceCoordinator: extracted save coordination logic for testability.
 *
 * This module handles the save orchestration that was previously embedded
 * in VaultSyncServer. By extracting it, we can test:
 * - append fails → checkpoint fallback succeeds
 * - append + checkpoint fail → lastPersistedStateVector does not advance
 * - queued saves cannot regress lastPersistedStateVector
 * - health transitions correctly
 */

import * as Y from "yjs";
import { bytesToHex } from "./hex.js";

/**
 * Short random identifier for a coordinator instance.  Only needs to differ
 * from the previous instance's value, so collision resistance is not critical.
 */
function randomEpochId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}

// Re-export for backwards compatibility with existing test imports
export type { DocStoreJournalStats as JournalStats };

/** Minimal storage interface that both ChunkedDocStore and SqlDocStore implement. */
export interface DocStore {
	appendUpdate(update: Uint8Array): Promise<DocStoreJournalStats | null> | DocStoreJournalStats | null;
	rewriteCheckpoint(update: Uint8Array, stateVector?: Uint8Array): Promise<void> | void;
	getJournalStats(): Promise<DocStoreJournalStats> | DocStoreJournalStats;
}

export interface DocStoreJournalStats {
	entryCount: number;
	totalBytes: number;
}

export const CHECKPOINT_FALLBACK_DELTA_BYTES = 2 * 1024 * 1024; // 2MB
export const CHECKPOINT_FALLBACK_AFTER_FAILURES = 2;
export const JOURNAL_COMPACT_MAX_ENTRIES = 50;
export const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024; // 1MB

export type PersistenceStatus = "healthy" | "degraded";

export interface PersistenceCoordinatorOptions {
	/** Byte threshold for full-checkpoint fallback instead of journal append. Default: 2MB */
	checkpointFallbackDeltaBytes?: number;
	/** Number of consecutive append failures before checkpoint fallback. Default: 2 */
	checkpointFallbackAfterFailures?: number;
	/** Max journal entries before compaction. Default: 50 */
	journalCompactMaxEntries?: number;
	/** Max journal bytes before compaction. Default: 1MB */
	journalCompactMaxBytes?: number;
}

export interface PersistenceHealth {
	status: PersistenceStatus;
	lastSaveStartedAt: string | null;
	lastSaveSucceededAt: string | null;
	lastSaveFailedAt: string | null;
	lastSaveError: string | null;
	successfulSaveCount: number;
	failedSaveCount: number;
	consecutiveSaveFailures: number;
	pendingPersistence: boolean;
	queuedSaveCount: number;
	lastDeltaBytes: number | null;
	lastPersistedStateVectorHash: string | null;
	journalEntryCount: number | null;
	journalBytes: number | null;
	checkpointFallbackCount: number;
	lastCompactionAt: string | null;
	lastCompactionReason: string | null;
	lastCompactionError: string | null;
	/**
	 * Whether the document holds changes that are not yet persisted.
	 *
	 * Driven by the Y.Doc "update" event, NOT by state-vector comparison.  See
	 * the note on `dirty` in PersistenceCoordinator for why that distinction is
	 * load-bearing.
	 */
	dirty: boolean;
	/**
	 * Monotonic count of successful persists by THIS coordinator.
	 *
	 * Echoed to clients so a receipt can mean "durably stored" rather than
	 * "applied in memory".  A state vector cannot serve that purpose: it tracks
	 * insert clocks, so a deletion-only change leaves it identical and any echo
	 * appears to confirm it.  A counter that only advances on a successful write
	 * distinguishes the two.
	 */
	persistedGeneration: number;
	/**
	 * Identifies the coordinator instance the generation belongs to.
	 *
	 * The counter lives in memory, so a Durable Object eviction restarts it at
	 * zero.  Without an epoch a client that had seen generation 40 would wait
	 * forever for 41.  On an epoch change the client re-baselines instead.
	 */
	generationEpoch: string;
}

export interface SaveResult {
	success: boolean;
	method: "append" | "checkpoint-fallback" | "immediate-fallback" | "skipped";
	error?: string;
	journalStats?: DocStoreJournalStats;
}

/**
 * Byte-compare two state vectors.
 *
 * ONLY valid for asking "does this baseline describe the same inserts as the
 * document right now".  It MUST NOT be used to detect whether the document
 * changed: state vectors track insert clocks and say nothing about the delete
 * set, so two equal state vectors can describe documents that differ by an
 * arbitrary number of deletions.  That confusion is the bug this file's `dirty`
 * flag exists to prevent.
 */
function equalStateVectors(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * PersistenceCoordinator manages the save chain for a Y.Doc.
 * Extracted from VaultSyncServer for testability.
 */
export class PersistenceCoordinator {
	private saveChain: Promise<void> = Promise.resolve();
	private lastPersistedStateVector: Uint8Array | null = null;
	private consecutiveSaveFailures = 0;

	/**
	 * Whether the document has changed since the last successful persist.
	 *
	 * THIS MUST NOT be derived from the state vector.  A Yjs state vector is a
	 * map of client -> highest clock, i.e. it tracks INSERTS only.  Deletions
	 * are recorded in the delete set, which the state vector does not describe
	 * at all.  "Select all, delete" on a 50MB document therefore leaves the
	 * state vector byte-identical, and a save gated on state-vector equality
	 * skips the write while reporting success — so the deletion never reaches
	 * storage and the document resurrects on the next cold load.
	 *
	 * The Y.Doc "update" event fires if and only if the document actually
	 * changed, for insertions and deletions alike, so it is the only sound
	 * trigger.  The delta itself is still computed against
	 * `lastPersistedStateVector`: `Y.encodeStateAsUpdate(doc, sv)` always
	 * carries the FULL delete set regardless of `sv`, so a delete-only change
	 * does produce a non-empty delta once we actually attempt the write.
	 *
	 * Defaults to TRUE, deliberately.  The listener below only observes updates
	 * that happen after construction, so a coordinator built over a document
	 * that already holds unsaved changes must assume the worst.  A redundant
	 * save costs one small journal row; a missed save loses user data.
	 * setInitialStateVector() is what establishes "clean", and the cold load
	 * path calls it once the loaded state is in memory.
	 */
	private dirty = true;

	/** Bound so it can be detached in dispose(). */
	private readonly onDocumentUpdate = (): void => {
		this.dirty = true;
		this.health.dirty = true;
	};

	private readonly checkpointFallbackDeltaBytes: number;
	private readonly checkpointFallbackAfterFailures: number;
	private readonly journalCompactMaxEntries: number;
	private readonly journalCompactMaxBytes: number;

	readonly health: PersistenceHealth = {
		status: "healthy",
		lastSaveStartedAt: null,
		lastSaveSucceededAt: null,
		lastSaveFailedAt: null,
		lastSaveError: null,
		successfulSaveCount: 0,
		failedSaveCount: 0,
		consecutiveSaveFailures: 0,
		pendingPersistence: false,
		queuedSaveCount: 0,
		lastDeltaBytes: null,
		lastPersistedStateVectorHash: null,
		journalEntryCount: null,
		journalBytes: null,
		checkpointFallbackCount: 0,
		lastCompactionAt: null,
		lastCompactionReason: null,
		lastCompactionError: null,
		dirty: true,
		persistedGeneration: 0,
		generationEpoch: "",
	};

	constructor(
		private document: Y.Doc,
		private readonly store: DocStore,
		private readonly trace?: (event: string, data: Record<string, unknown>) => void,
		options?: PersistenceCoordinatorOptions,
	) {
		this.checkpointFallbackDeltaBytes =
			options?.checkpointFallbackDeltaBytes ?? CHECKPOINT_FALLBACK_DELTA_BYTES;
		this.checkpointFallbackAfterFailures =
			options?.checkpointFallbackAfterFailures ?? CHECKPOINT_FALLBACK_AFTER_FAILURES;
		this.journalCompactMaxEntries =
			options?.journalCompactMaxEntries ?? JOURNAL_COMPACT_MAX_ENTRIES;
		this.journalCompactMaxBytes =
			options?.journalCompactMaxBytes ?? JOURNAL_COMPACT_MAX_BYTES;

		this.health.generationEpoch = randomEpochId();

		this.document.on("update", this.onDocumentUpdate);
	}

	/** Detach the document listener.  Tests create many coordinators. */
	dispose(): void {
		this.document.off("update", this.onDocumentUpdate);
	}

	/**
	 * Point the coordinator at a replacement Y.Doc holding identical state.
	 *
	 * Used by document re-materialisation, which rebuilds the document to
	 * discard accumulated V8 rope structures.  The replacement carries exactly
	 * the same state, so `lastPersistedStateVector` stays valid and the health
	 * counters stay meaningful; only the object the dirty listener is attached
	 * to changes.
	 *
	 * The dirty flag is deliberately preserved rather than cleared: if the
	 * document had unsaved changes before the swap it still has them after.
	 */
	retargetDocument(next: Y.Doc): void {
		if (next === this.document) return;
		this.document.off("update", this.onDocumentUpdate);
		this.document = next;
		this.document.on("update", this.onDocumentUpdate);
	}

	/**
	 * Record the state vector that storage currently reflects, i.e. the base the
	 * next delta is computed against.
	 *
	 * This also decides whether the document counts as clean, and the two are
	 * NOT the same claim.  Cold load materialises the persisted state into the
	 * document and then reports that exact state vector, so document and storage
	 * agree and the document is clean.  A caller that supplies a baseline
	 * DIFFERENT from the document's current state vector is saying "storage is
	 * behind" — there is unpersisted state, so the document must stay dirty.
	 *
	 * Marking clean is gated on that equality rather than done unconditionally,
	 * because unconditional clearing would drop whatever the document already
	 * held at construction time.  Ambiguity resolves toward dirty: a redundant
	 * save costs one journal row, a missed save loses data.
	 */
	setInitialStateVector(sv: Uint8Array): void {
		this.lastPersistedStateVector = sv;
		this.health.lastPersistedStateVectorHash = bytesToHex(sv.slice(0, 16));

		const documentMatchesStorage = equalStateVectors(sv, Y.encodeStateVector(this.document));
		if (documentMatchesStorage) {
			this.dirty = false;
			this.health.dirty = false;
		}
	}

	/** Get the last successfully persisted state vector. */
	getLastPersistedStateVector(): Uint8Array | null {
		return this.lastPersistedStateVector;
	}

	/**
	 * Enqueue a save operation. Returns a promise that resolves when the save
	 * completes (successfully or not).
	 */
	enqueueSave(): Promise<SaveResult> {
		// Set pendingPersistence immediately at enqueue time
		this.health.queuedSaveCount++;
		this.health.pendingPersistence = true;

		const run = this.saveChain.then(async (): Promise<SaveResult> => {
			try {
				const result = await this.executeSave();
				if (!result.success) {
					// The document still holds unpersisted changes.  Re-arm the
					// flag so the next save retries instead of silently skipping.
					this.dirty = true;
					this.health.dirty = true;
				}
				return result;
			} finally {
				this.health.queuedSaveCount = Math.max(0, this.health.queuedSaveCount - 1);
				// pendingPersistence is true if:
				// - more saves are queued, OR
				// - we're in degraded state, OR
				// - the document is dirty (including delete-only changes)
				this.health.pendingPersistence =
					this.health.queuedSaveCount > 0
					|| this.health.status === "degraded"
					|| this.dirty;
			}
		});

		// Keep chain resolved so future saves aren't blocked
		this.saveChain = run.then(() => {}).catch(() => {});
		return run;
	}

	/**
	 * Rewrite the checkpoint from the current document and clear the journal,
	 * regardless of delta size or dirty state.
	 *
	 * Needed because a journal is replayed verbatim on every cold load.  After a
	 * change that REMOVES content — a tombstone reap, say — the journal still
	 * holds the entries that inserted it, so each subsequent cold load
	 * re-materialises the removed content before the delete set collapses it
	 * again.  Measured on a 2M-character body: replaying [insert, reap] leaves
	 * ~6.3MiB resident, while loading the equivalent checkpoint leaves ~0.4MiB.
	 * Appending the removal is therefore not enough; the entries that created
	 * the content have to stop being replayed.
	 *
	 * Ordinary journal compaction eventually does this, but only at >50 entries
	 * or >1MB, so a vault that reaps and then goes quiet can sit in the
	 * expensive state indefinitely.
	 *
	 * Serialised through the same chain as enqueueSave so it cannot race a save.
	 */
	forceCheckpoint(reason: string): Promise<SaveResult> {
		this.health.queuedSaveCount++;
		this.health.pendingPersistence = true;

		const run = this.saveChain.then(async (): Promise<SaveResult> => {
			try {
				// Cleared before encoding, for the same reason executeSave does:
				// a change arriving mid-write must re-mark the document.
				this.dirty = false;
				this.health.dirty = false;
				const full = Y.encodeStateAsUpdate(this.document);
				const result = await this.executeCheckpointFallback(full, reason);
				if (!result.success) {
					this.dirty = true;
					this.health.dirty = true;
				}
				return result;
			} finally {
				this.health.queuedSaveCount = Math.max(0, this.health.queuedSaveCount - 1);
				this.health.pendingPersistence =
					this.health.queuedSaveCount > 0
					|| this.health.status === "degraded"
					|| this.dirty;
			}
		});

		this.saveChain = run.then(() => {}).catch(() => {});
		return run;
	}

	private async executeSave(): Promise<SaveResult> {
		this.health.lastSaveStartedAt = new Date().toISOString();

		// Gate on the update-driven dirty flag, never on state-vector equality.
		// See the `dirty` field for the full rationale: state vectors do not
		// describe the delete set, so an SV comparison treats "select all,
		// delete" as a no-op and drops the write.
		if (!this.dirty) {
			this.trace?.("save.skipped_not_dirty", {});
			return { success: true, method: "skipped" };
		}

		// Clear BEFORE encoding.  An update that lands while this save is in
		// flight must re-mark the document rather than be swallowed by the
		// clear that follows a successful write.
		this.dirty = false;
		this.health.dirty = false;

		// Compute delta inside serialized save task
		const baseStateVector = this.lastPersistedStateVector;
		const currentStateVector = Y.encodeStateVector(this.document);

		const delta = baseStateVector
			? Y.encodeStateAsUpdate(this.document, baseStateVector)
			: Y.encodeStateAsUpdate(this.document);

		if (delta.byteLength === 0) {
			this.trace?.("save.skipped_empty_delta", {});
			return { success: true, method: "skipped" };
		}

		this.trace?.("save.delta_computed", { deltaBytes: delta.byteLength });

		// Strategy: checkpoint fallback for large deltas or consecutive failures
		const useCheckpointFallback =
			delta.byteLength > this.checkpointFallbackDeltaBytes ||
			this.consecutiveSaveFailures >= this.checkpointFallbackAfterFailures;

		if (useCheckpointFallback) {
			return this.executeCheckpointFallback(delta);
		}

		// Normal path: journal append
		return this.executeAppend(delta, currentStateVector);
	}

	private async executeCheckpointFallback(
		delta: Uint8Array,
		reasonOverride?: string,
	): Promise<SaveResult> {
		const reason =
			reasonOverride ??
			(delta.byteLength > this.checkpointFallbackDeltaBytes
				? "delta_exceeds_threshold"
				: "consecutive_failures");

		this.trace?.("save.checkpoint_fallback", {
			reason,
			deltaBytes: delta.byteLength,
			consecutiveFailures: this.consecutiveSaveFailures,
		});

		try {
			const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
			const checkpointStateVector = Y.encodeStateVector(this.document);
			const checkpointSvHash = bytesToHex(checkpointStateVector.slice(0, 16));

			await this.store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);

			// Success — update state
			this.lastPersistedStateVector = checkpointStateVector;
			this.consecutiveSaveFailures = 0;
			this.consecutiveCompactionFailures = 0; // Reset circuit breaker
			this.health.status = "healthy";
			this.health.lastSaveSucceededAt = new Date().toISOString();
			this.health.lastSaveError = null; // Clear stale error on recovery
			this.health.successfulSaveCount++;
			this.health.persistedGeneration++;
			this.health.lastDeltaBytes = delta.byteLength;
			this.health.lastPersistedStateVectorHash = checkpointSvHash;
			this.health.checkpointFallbackCount++;
			this.health.consecutiveSaveFailures = 0;

			const stats = await this.store.getJournalStats();
			this.health.journalEntryCount = stats.entryCount;
			this.health.journalBytes = stats.totalBytes;

			this.trace?.("save.checkpoint_fallback_succeeded", {
				persistedStateVectorHash: checkpointSvHash,
			});

			return { success: true, method: "checkpoint-fallback", journalStats: stats };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const errorClass = err instanceof Error ? err.constructor.name : typeof err;

			this.consecutiveSaveFailures++;
			this.health.lastSaveFailedAt = new Date().toISOString();
			this.health.lastSaveError = `${errorClass}: ${errorMessage} (checkpoint fallback)`;
			this.health.failedSaveCount++;
			this.health.consecutiveSaveFailures = this.consecutiveSaveFailures;
			this.health.status = "degraded";

			this.trace?.("save.checkpoint_fallback_failed", {
				errorClass,
				message: errorMessage,
			});

			return { success: false, method: "checkpoint-fallback", error: errorMessage };
		}
	}

	private async executeAppend(
		delta: Uint8Array,
		currentStateVector: Uint8Array,
	): Promise<SaveResult> {
		let journalStats: DocStoreJournalStats;

		try {
			const result = await this.store.appendUpdate(delta);

			// null means the delta exceeded the store's per-entry size limit.
			// Route directly to checkpoint fallback — this is expected control
			// flow for large deltas, not an error.
			if (result === null) {
				this.trace?.("save.append_oversized", {
					deltaBytes: delta.byteLength,
					note: "delta exceeds journal entry size limit, routing to checkpoint",
				});
				return this.executeCheckpointFallback(delta);
			}

			journalStats = result;
		} catch (appendErr) {
			const errorMessage = appendErr instanceof Error ? appendErr.message : String(appendErr);
			const errorClass = appendErr instanceof Error ? appendErr.constructor.name : typeof appendErr;

			this.consecutiveSaveFailures++;
			this.health.lastSaveFailedAt = new Date().toISOString();
			this.health.lastSaveError = `${errorClass}: ${errorMessage}`;
			this.health.failedSaveCount++;
			this.health.consecutiveSaveFailures = this.consecutiveSaveFailures;
			this.health.status = "degraded";

			this.trace?.("save.append_failed", {
				errorClass,
				message: errorMessage,
				consecutiveFailures: this.consecutiveSaveFailures,
			});

			// Immediately attempt checkpoint fallback if threshold is reached
			if (this.consecutiveSaveFailures >= this.checkpointFallbackAfterFailures) {
				this.trace?.("save.immediate_checkpoint_fallback", {
					reason: "consecutive_failures_after_append",
					consecutiveFailures: this.consecutiveSaveFailures,
				});

				const fallbackResult = await this.executeImmediateFallback(delta);
				if (fallbackResult.success) {
					return fallbackResult;
				}
				// Fallback also failed — return fallback result (which has method: "immediate-fallback")
				return fallbackResult;
			}

			return { success: false, method: "append", error: errorMessage };
		}

		// Success — advance persisted state vector
		const svHash = bytesToHex(currentStateVector.slice(0, 16));
		this.lastPersistedStateVector = currentStateVector;
		this.consecutiveSaveFailures = 0;
		this.health.status = "healthy";
		this.health.lastSaveSucceededAt = new Date().toISOString();
		this.health.lastSaveError = null; // Clear stale error on recovery
		this.health.successfulSaveCount++;
		this.health.persistedGeneration++;
		this.health.lastDeltaBytes = delta.byteLength;
		this.health.lastPersistedStateVectorHash = svHash;
		this.health.journalEntryCount = journalStats.entryCount;
		this.health.journalBytes = journalStats.totalBytes;
		this.health.consecutiveSaveFailures = 0;

		this.trace?.("save.append_succeeded", {
			journalEntryCount: journalStats.entryCount,
			journalBytes: journalStats.totalBytes,
			deltaBytes: delta.byteLength,
			persistedStateVectorHash: svHash,
		});

		// Compaction if needed
		if (
			journalStats.entryCount > this.journalCompactMaxEntries ||
			journalStats.totalBytes > this.journalCompactMaxBytes
		) {
			await this.executeCompaction(journalStats);
		}

		return { success: true, method: "append", journalStats };
	}

	private async executeImmediateFallback(delta: Uint8Array): Promise<SaveResult> {
		try {
			const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
			const checkpointStateVector = Y.encodeStateVector(this.document);
			const checkpointSvHash = bytesToHex(checkpointStateVector.slice(0, 16));

			await this.store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);

			// Success
			this.lastPersistedStateVector = checkpointStateVector;
			this.consecutiveSaveFailures = 0;
			this.consecutiveCompactionFailures = 0; // Reset circuit breaker
			this.health.status = "healthy";
			this.health.lastSaveSucceededAt = new Date().toISOString();
			this.health.lastSaveError = null; // Clear stale error on recovery
			this.health.successfulSaveCount++;
			this.health.persistedGeneration++;
			this.health.lastDeltaBytes = delta.byteLength;
			this.health.lastPersistedStateVectorHash = checkpointSvHash;
			this.health.checkpointFallbackCount++;
			this.health.consecutiveSaveFailures = 0;

			const stats = await this.store.getJournalStats();
			this.health.journalEntryCount = stats.entryCount;
			this.health.journalBytes = stats.totalBytes;

			this.trace?.("save.immediate_checkpoint_fallback_succeeded", {
				persistedStateVectorHash: checkpointSvHash,
			});

			return { success: true, method: "immediate-fallback", journalStats: stats };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const errorClass = err instanceof Error ? err.constructor.name : typeof err;

			this.trace?.("save.immediate_checkpoint_fallback_failed", {
				errorClass,
				message: errorMessage,
			});

			return { success: false, method: "immediate-fallback", error: errorMessage };
		}
	}

	private consecutiveCompactionFailures = 0;

	private async executeCompaction(journalStats: DocStoreJournalStats): Promise<void> {
		const compactionReason =
			journalStats.entryCount > this.journalCompactMaxEntries
				? "entry_count_exceeded"
				: "byte_size_exceeded";

		// Circuit breaker: stop attempting compaction after 3 consecutive failures.
		// The next successful checkpoint-fallback (triggered by append failures)
		// will reset the counter via resetCompactionCircuitBreaker().
		if (this.consecutiveCompactionFailures >= 3) {
			this.trace?.("save.compaction_circuit_breaker", {
				reason: compactionReason,
				consecutiveCompactionFailures: this.consecutiveCompactionFailures,
				journalEntryCount: journalStats.entryCount,
				journalBytes: journalStats.totalBytes,
				note: "compaction suspended until next successful checkpoint write",
			});
			return;
		}

		try {
			const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
			const checkpointStateVector = Y.encodeStateVector(this.document);
			const checkpointSvHash = bytesToHex(checkpointStateVector.slice(0, 16));

			await this.store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);

			this.lastPersistedStateVector = checkpointStateVector;
			this.health.lastPersistedStateVectorHash = checkpointSvHash;
			this.health.lastCompactionAt = new Date().toISOString();
			this.health.lastCompactionReason = compactionReason;
			this.health.lastCompactionError = null;
			this.consecutiveCompactionFailures = 0;

			const compactedStats = await this.store.getJournalStats();
			this.health.journalEntryCount = compactedStats.entryCount;
			this.health.journalBytes = compactedStats.totalBytes;

			this.trace?.("save.compaction_succeeded", {
				reason: compactionReason,
				persistedStateVectorHash: checkpointSvHash,
			});
		} catch (err) {
			// Compaction failure after successful append is NOT a data-loss event,
			// but it IS an operational issue that must be visible.  The journal
			// will grow until compaction succeeds.
			const errorMessage = err instanceof Error ? err.message : String(err);
			const errorClass = err instanceof Error ? err.constructor.name : typeof err;

			this.consecutiveCompactionFailures++;
			this.health.lastCompactionAt = new Date().toISOString();
			this.health.lastCompactionReason = compactionReason;
			this.health.lastCompactionError = `${errorClass}: ${errorMessage}`;

			console.error(
				`[yaos-sync:persistence] compaction failed (attempt ${this.consecutiveCompactionFailures}/3):`,
				errorMessage,
			);

			this.trace?.("save.compaction_failed", {
				reason: compactionReason,
				errorClass,
				message: errorMessage,
				consecutiveCompactionFailures: this.consecutiveCompactionFailures,
				journalEntryCount: journalStats.entryCount,
				journalBytes: journalStats.totalBytes,
			});
		}
	}

	/** Reset the compaction circuit breaker after a successful checkpoint write. */
	resetCompactionCircuitBreaker(): void {
		this.consecutiveCompactionFailures = 0;
	}
}
