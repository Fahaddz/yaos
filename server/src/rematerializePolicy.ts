/**
 * When to rebuild the in-memory document.
 *
 * Extracted from VaultSyncServer for the same reason documentSummary and the
 * tombstone reaper were: the decision is pure, it has edge cases that matter,
 * and it is otherwise only reachable through a live Durable Object — which is
 * how a counting rule with a silent failure mode shipped unchallenged once
 * already.
 *
 * WHAT IS BEING TRADED
 *
 * Rebuilding discards V8 rope structures that Yjs accumulates by concatenating
 * adjacent ContentStrings, which is the difference between a warm document and
 * a freshly cold-loaded one holding identical state — measured at 29.3 MiB
 * versus 7.1 MiB for the same 2.86MB vault (scripts/bench-warm-memory.mjs).
 * It costs one encode plus one decode, 3-9ms for well-merged documents.
 *
 * So the policy wants to fire often enough to bound drift, and rarely enough
 * that the CPU is noise.  Neither trigger alone does that.
 */

/**
 * Applied updates after which the document is rebuilt.
 *
 * Updates, not bytes or time, because updates are what build rope, and Workers
 * exposes no heap API to measure the result directly.  The growth curve in
 * bench-warm-memory.mjs is steepest through the first few thousand updates.
 */
export const REMATERIALIZE_UPDATE_THRESHOLD = 5000;

/**
 * Age after which a document that has taken a non-trivial number of updates is
 * rebuilt regardless of the update threshold.
 *
 * Without this, a vault edited steadily but slowly stays warm for hours and
 * drifts the whole time without ever reaching 5,000 updates.  Hibernation does
 * not rescue it either: an object holding an open WebSocket stays resident.
 */
export const REMATERIALIZE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Floor for the age trigger.
 *
 * A rebuild on a near-idle document is pure cost: no updates means no rope, so
 * there is nothing to recover and the encode is wasted.  This is what stops
 * the age trigger from degenerating into a timer that burns CPU on quiet rooms.
 */
export const REMATERIALIZE_MIN_UPDATES = 200;

export type RematerializeReason = "update-threshold" | "age";

export interface RematerializeInput {
	/** Updates applied since the last rebuild (or since the instance started). */
	updatesSince: number;
	/** Milliseconds since the last rebuild (or since the instance started). */
	msSinceBaseline: number;
}

export interface RematerializePolicy {
	updateThreshold?: number;
	maxAgeMs?: number;
	minUpdates?: number;
}

/**
 * Decide whether to rebuild, and why.
 *
 * Returns null when neither trigger applies.  The reason is returned rather
 * than a boolean so the trace records which rule fired — the two have very
 * different implications for tuning, and a boolean would erase that.
 */
export function shouldRematerialize(
	input: RematerializeInput,
	policy: RematerializePolicy = {},
): RematerializeReason | null {
	const updateThreshold = policy.updateThreshold ?? REMATERIALIZE_UPDATE_THRESHOLD;
	const maxAgeMs = policy.maxAgeMs ?? REMATERIALIZE_MAX_AGE_MS;
	const minUpdates = policy.minUpdates ?? REMATERIALIZE_MIN_UPDATES;

	// Update threshold wins when both apply: it is the direct measure of how
	// much rope has been built, where age is only a proxy for it.
	if (input.updatesSince >= updateThreshold) return "update-threshold";
	if (input.msSinceBaseline >= maxAgeMs && input.updatesSince >= minUpdates) return "age";
	return null;
}
