/**
 * When the client should rebuild its sync stack to reclaim memory.
 *
 * The client has the same rope drift as the server — Yjs concatenates adjacent
 * inserts and V8 never flattens the result — but not the same remedy.  The
 * server swaps its Y.Doc in place in a few milliseconds.  On the client the
 * provider, IndexedDB persistence, DiskMirror's transaction hook and every open
 * editor binding are wired to that exact document, so reclaiming means tearing
 * the stack down and reinitialising it: a reconnect, an IndexedDB re-read and a
 * reconciliation pass.
 *
 * That asymmetry sets the whole policy.  The server rebuilds eagerly because it
 * is nearly free.  The client must only rebuild when the drift is large AND the
 * disruption is close to nothing, which is why `connected` is a hard gate
 * rather than a preference: while a socket is open a rebuild drops it, and
 * dropping a live sync session to save memory is the wrong trade at any
 * threshold.
 */

/**
 * Applied updates before a rebuild is worth its cost.
 *
 * Four times the server's threshold, because the server pays an encode/decode
 * and the client pays a full stack restart.  Bench data (scripts/bench-warm-
 * memory.mjs) shows drift is already several-fold by this point, so waiting
 * longer trades real memory for a saving that no longer matters.
 */
export const CLIENT_REMATERIALIZE_UPDATE_THRESHOLD = 20_000;

export interface ClientRematerializeInput {
	/** Applied Y.Doc updates since this sync stack was built. */
	updatesSince: number;
	/** Whether a sync socket is currently established. */
	connected: boolean;
	/** Whether a teardown or reinitialisation is already running. */
	busy: boolean;
}

export interface ClientRematerializePolicy {
	updateThreshold?: number;
}

/**
 * Whether to rebuild now.
 *
 * Deliberately has no time-based trigger, unlike the server's.  Time is a proxy
 * for accumulated updates, and on the client the proxy is not worth the risk of
 * restarting a stack that has barely changed.
 */
export function shouldRematerializeClient(
	input: ClientRematerializeInput,
	policy: ClientRematerializePolicy = {},
): boolean {
	if (input.busy) return false;
	// Never interrupt a live session.  A rebuild costs a reconnect, and a user
	// who is actively syncing values that far more than the megabytes back.
	if (input.connected) return false;
	const threshold = policy.updateThreshold ?? CLIENT_REMATERIALIZE_UPDATE_THRESHOLD;
	return input.updatesSince >= threshold;
}
