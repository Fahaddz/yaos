/**
 * Tests for the client-side rebuild trigger.
 *
 * The client's rebuild is a full sync-stack restart — reconnect, IndexedDB
 * re-read, reconciliation pass — not the server's few-millisecond document
 * swap.  That asymmetry is the whole reason this policy is separate from the
 * server's, and every case here defends a consequence of it.
 */

import {
	CLIENT_REMATERIALIZE_UPDATE_THRESHOLD,
	shouldRematerializeClient,
} from "../src/sync/clientRematerializePolicy";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  \x1b[32mPASS\x1b[0m  ${message}`);
		passed++;
	} else {
		console.log(`  \x1b[31mFAIL\x1b[0m  ${message}`);
		failed++;
	}
}

const T = CLIENT_REMATERIALIZE_UPDATE_THRESHOLD;

console.log("\n--- Test 1: never interrupts a live session ---");
{
	// This is the load-bearing rule. A rebuild drops the socket, and dropping a
	// live sync session to reclaim memory is the wrong trade at any threshold.
	assert(
		shouldRematerializeClient({ updatesSince: T * 100, connected: true, busy: false }) === false,
		"connected blocks a rebuild even at 100x the threshold",
	);
	assert(
		shouldRematerializeClient({ updatesSince: T, connected: false, busy: false }) === true,
		"the same drift rebuilds once disconnected",
	);
}

console.log("\n--- Test 2: threshold ---");
{
	assert(
		shouldRematerializeClient({ updatesSince: T, connected: false, busy: false }) === true,
		"fires exactly at the threshold",
	);
	assert(
		shouldRematerializeClient({ updatesSince: T - 1, connected: false, busy: false }) === false,
		"does not fire one update short",
	);
	assert(
		shouldRematerializeClient({ updatesSince: 0, connected: false, busy: false }) === false,
		"a freshly built stack is never immediately rebuilt",
	);
}

console.log("\n--- Test 3: never overlaps itself ---");
{
	// The trigger runs on a 3s status tick but a restart takes far longer than
	// one tick, so without this guard the ticks would stack restarts on top of
	// a half-torn stack.
	assert(
		shouldRematerializeClient({ updatesSince: T * 10, connected: false, busy: true }) === false,
		"busy blocks a second concurrent rebuild",
	);
	assert(
		shouldRematerializeClient({ updatesSince: T * 10, connected: false, busy: false }) === true,
		"and allows it again once the previous one finishes",
	);
}

console.log("\n--- Test 4: client threshold is well above the server's ---");
{
	// Not a style preference: the server pays an encode+decode, the client pays
	// a reconnect plus an IndexedDB re-read plus a reconciliation pass.
	assert(
		CLIENT_REMATERIALIZE_UPDATE_THRESHOLD >= 20_000,
		`threshold is at least 20k (is ${CLIENT_REMATERIALIZE_UPDATE_THRESHOLD})`,
	);
}

console.log("\n--- Test 5: policy override ---");
{
	assert(
		shouldRematerializeClient(
			{ updatesSince: 10, connected: false, busy: false },
			{ updateThreshold: 10 },
		) === true,
		"custom threshold is honoured",
	);
	assert(
		shouldRematerializeClient(
			{ updatesSince: 10, connected: true, busy: false },
			{ updateThreshold: 10 },
		) === false,
		"a custom threshold cannot override the connected gate",
	);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) process.exit(1);
