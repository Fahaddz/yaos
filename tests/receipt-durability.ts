/**
 * Tests for the receipt confirmation rule.
 *
 * THE BUG THIS PINS
 *
 * A Yjs state vector maps client -> highest clock: it describes INSERTS.
 * Deletions live in the delete set, which it does not describe.  So a
 * deletion-only local change captures a candidate state vector IDENTICAL to the
 * previous one — which the server already had — and `isStateVectorGe(serverSv,
 * candidateSv)` returns true on the very next echo.  Deleting a paragraph was
 * reported to the user as "the server has your state" without the server having
 * received, let alone stored, anything.
 *
 * The fix requires the server's persist counter to have ADVANCED past the value
 * observed when the candidate was captured.  That works for deletions and
 * insertions alike, and upgrades the claim from "applied in memory" to "written
 * to storage" — which is what the receipt always implied.
 *
 * Servers that predate the marker keep the old state-vector behaviour, so
 * upgrading the client alone does not withdraw receipts they already grant.
 */

import * as Y from "yjs";
import { ServerAckTracker } from "../src/sync/serverAckTracker";
import { parseSvEchoMessageDetailed } from "../src/sync/svEchoMessage";
import { makeSvEchoCustomMessage } from "../server/src/svEcho";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);
		passed++;
	} else {
		console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
		failed++;
	}
}

const EPOCH = "epoch-a";

/**
 * A tracker attached to a doc, with the same origin plumbing vaultSync uses.
 * `provider` is the origin that marks an update as REMOTE; anything else counts
 * as a local change worth tracking.
 */
function makeTracker(): { doc: Y.Doc; tracker: ServerAckTracker; provider: object } {
	const doc = new Y.Doc();
	const provider = { name: "provider" };
	const tracker = new ServerAckTracker();
	tracker.attach(doc, () => Y.encodeStateVector(doc), provider, { name: "idb" });
	return { doc, tracker, provider };
}

const sv = (doc: Y.Doc): Uint8Array => Y.encodeStateVector(doc);

/** Server-side echo, parsed by the client, exactly as the wire does it. */
function echo(tracker: ServerAckTracker, doc: Y.Doc, generation: number | null): void {
	const payload = generation === null
		? makeSvEchoCustomMessage(sv(doc))
		: makeSvEchoCustomMessage(sv(doc), { generation, epoch: EPOCH });
	const parsed = parseSvEchoMessageDetailed(payload);
	if (parsed.kind !== "valid_sv_echo") throw new Error(`echo did not parse: ${parsed.kind}`);
	tracker.recordServerSvEcho(parsed.sv, parsed.durability);
}

// ---------------------------------------------------------------------------

console.log("\n--- Test 1: the wire carries the marker, and stays schema 1 ---");
{
	const doc = new Y.Doc();
	doc.getText("t").insert(0, "hello");

	const withMarker = JSON.parse(makeSvEchoCustomMessage(sv(doc), { generation: 7, epoch: EPOCH }));
	assert(withMarker.schema === 1, "schema is still 1, so existing clients keep accepting echoes");
	assert(withMarker.gen === 7, "generation carried");
	assert(withMarker.genEpoch === EPOCH, "epoch carried");

	const without = JSON.parse(makeSvEchoCustomMessage(sv(doc)));
	assert(without.gen === undefined, "no marker emitted when none supplied");

	const parsed = parseSvEchoMessageDetailed(JSON.stringify(withMarker));
	assert(parsed.kind === "valid_sv_echo", "marker payload parses");
	assert(parsed.kind === "valid_sv_echo" && parsed.durability?.generation === 7, "generation parsed");

	const parsedOld = parseSvEchoMessageDetailed(JSON.stringify(without));
	assert(parsedOld.kind === "valid_sv_echo" && parsedOld.durability === null, "absent marker parses as null");

	// A half-written marker must degrade, not fail the whole echo.
	const partial = parseSvEchoMessageDetailed(JSON.stringify({ ...withMarker, genEpoch: undefined }));
	assert(partial.kind === "valid_sv_echo" && partial.durability === null, "partial marker treated as absent");
	doc.destroy();
}

console.log("\n--- Test 2: a DELETION is not confirmed until a persist happens ---");
{
	const { doc, tracker } = makeTracker();
	const text = doc.getText("t");
	// onConnect sends a baseline echo before any local edit, so a real client
	// always has a generation to measure against.  Mirror that.
	echo(tracker, doc, 0);
	doc.transact(() => { text.insert(0, "alpha beta gamma"); });
	echo(tracker, doc, 1);                       // insert persisted
	assert(tracker.serverAppliedLocalState === true, "the insert is confirmed");

	const svBefore = Buffer.from(sv(doc)).toString("hex");
	doc.transact(() => { text.delete(0, 6); });  // deletion only
	const svAfter = Buffer.from(sv(doc)).toString("hex");
	assert(svBefore === svAfter, "state vector unchanged by the deletion (the precondition)");
	assert(tracker.hasUnconfirmedCandidate, "the deletion is a pending candidate");

	// The server applied it but has not saved yet: same generation.
	echo(tracker, doc, 1);
	assert(
		tracker.serverAppliedLocalState === false,
		"NOT confirmed while the persist counter has not advanced",
	);
	assert(tracker.hasUnconfirmedCandidate, "still pending");

	// The save completes.
	echo(tracker, doc, 2);
	assert(tracker.serverAppliedLocalState === true, "confirmed once the counter advances");
	assert(!tracker.hasUnconfirmedCandidate, "no longer pending");
	doc.destroy();
}

console.log("\n--- Test 3: the old rule confirms that deletion immediately (the bug) ---");
{
	// Same sequence with no marker: reproduces the false positive, so the test
	// pins the bug rather than the implementation.
	const { doc, tracker } = makeTracker();
	const text = doc.getText("t");
	doc.transact(() => { text.insert(0, "alpha beta gamma"); });
	echo(tracker, doc, null);
	doc.transact(() => { text.delete(0, 6); });
	assert(tracker.hasUnconfirmedCandidate, "deletion pending before any echo");
	echo(tracker, doc, null);
	assert(
		tracker.serverAppliedLocalState === true,
		"legacy fallback confirms the deletion with no persist at all (documented weakness)",
	);
	doc.destroy();
}

console.log("\n--- Test 4: an INSERT still needs the counter to advance ---");
{
	const { doc, tracker } = makeTracker();
	echo(tracker, doc, 5);                       // establish a baseline
	doc.transact(() => { doc.getText("t").insert(0, "new content"); });
	echo(tracker, doc, 5);
	assert(tracker.serverAppliedLocalState === false, "applied-but-unsaved insert is not confirmed");
	echo(tracker, doc, 6);
	assert(tracker.serverAppliedLocalState === true, "confirmed after the save");
	doc.destroy();
}

console.log("\n--- Test 5: a server restart re-baselines instead of hanging ---");
{
	const { doc, tracker } = makeTracker();
	const text = doc.getText("t");
	doc.transact(() => { text.insert(0, "content"); });
	echo(tracker, doc, 40);
	doc.transact(() => { text.delete(0, 3); });

	// New instance: counter restarts at 0 under a different epoch.  Without epoch
	// handling the client would wait forever for 41.
	const restart = JSON.parse(makeSvEchoCustomMessage(sv(doc), { generation: 0, epoch: "epoch-b" }));
	const parsed = parseSvEchoMessageDetailed(JSON.stringify(restart));
	if (parsed.kind !== "valid_sv_echo") throw new Error("restart echo did not parse");
	tracker.recordServerSvEcho(parsed.sv, parsed.durability);
	assert(
		tracker.serverAppliedLocalState === false,
		"the restart echo does not confirm — the new instance may not hold the change",
	);

	// And progress on the new instance confirms normally.
	const next = JSON.parse(makeSvEchoCustomMessage(sv(doc), { generation: 1, epoch: "epoch-b" }));
	const parsedNext = parseSvEchoMessageDetailed(JSON.stringify(next));
	if (parsedNext.kind !== "valid_sv_echo") throw new Error("next echo did not parse");
	tracker.recordServerSvEcho(parsedNext.sv, parsedNext.durability);
	assert(tracker.serverAppliedLocalState === true, "confirmed by progress after the restart");
	doc.destroy();
}

console.log("\n--- Test 6: a remote update is not a local candidate ---");
{
	const { doc, tracker, provider } = makeTracker();
	const other = new Y.Doc();
	other.getText("t").insert(0, "from another device");
	// Applied with the provider as origin => remote, must not create a candidate.
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), provider);
	assert(!tracker.hasUnconfirmedCandidate, "remote updates do not create candidates");
	doc.destroy();
	other.destroy();
}

console.log("\n--- Test 7: no baseline yet means no confirmation ---");
{
	// A local change before any echo has been seen: there is nothing to advance
	// past, so the tracker must wait rather than assume.
	const { doc, tracker } = makeTracker();
	doc.transact(() => { doc.getText("t").insert(0, "first ever change"); });
	echo(tracker, doc, 3);
	assert(
		tracker.serverAppliedLocalState === false,
		"first echo only establishes the baseline",
	);
	echo(tracker, doc, 4);
	assert(tracker.serverAppliedLocalState === true, "next persist confirms");
	doc.destroy();
}

// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(56)}\n`);

if (failed > 0) process.exit(1);
