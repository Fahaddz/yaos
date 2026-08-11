/**
 * Tests for the re-materialisation trigger.
 *
 * The decision is pure but the edge cases are not obvious, and it is otherwise
 * only reachable through a live Durable Object.  Every case here defends a
 * property that was chosen deliberately, not an implementation detail:
 *
 *   - an idle document is never rebuilt, however long it has been warm
 *   - a slowly-edited document IS eventually rebuilt, which the update
 *     threshold alone would never do
 *   - the reported reason distinguishes the two, because they imply different
 *     tuning
 */

import {
	REMATERIALIZE_MAX_AGE_MS,
	REMATERIALIZE_MIN_UPDATES,
	REMATERIALIZE_UPDATE_THRESHOLD,
	shouldRematerialize,
} from "../server/src/rematerializePolicy";

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

const HOUR = REMATERIALIZE_MAX_AGE_MS;

console.log("\n--- Test 1: update threshold ---");
{
	assert(
		shouldRematerialize({ updatesSince: REMATERIALIZE_UPDATE_THRESHOLD, msSinceBaseline: 0 })
			=== "update-threshold",
		"fires exactly at the threshold",
	);
	assert(
		shouldRematerialize({ updatesSince: REMATERIALIZE_UPDATE_THRESHOLD - 1, msSinceBaseline: 0 })
			=== null,
		"does not fire one update short",
	);
	assert(
		shouldRematerialize({ updatesSince: 500_000, msSinceBaseline: 0 }) === "update-threshold",
		"fires far above the threshold",
	);
}

console.log("\n--- Test 2: age backstop ---");
{
	assert(
		shouldRematerialize({ updatesSince: REMATERIALIZE_MIN_UPDATES, msSinceBaseline: HOUR })
			=== "age",
		"fires at max age once the minimum updates are met",
	);
	assert(
		shouldRematerialize({ updatesSince: REMATERIALIZE_MIN_UPDATES, msSinceBaseline: HOUR - 1 })
			=== null,
		"does not fire one millisecond short of max age",
	);
	assert(
		shouldRematerialize({ updatesSince: 4999, msSinceBaseline: HOUR * 24 }) === "age",
		"a slow vault below the update threshold is still rebuilt eventually",
	);
}

console.log("\n--- Test 3: idle documents are never rebuilt ---");
{
	// The whole point of the minimum: no updates means no rope, so a rebuild
	// would burn an encode to recover nothing.  A bare timer would get this
	// wrong, and it would be wrong on every quiet room in the fleet.
	assert(
		shouldRematerialize({ updatesSince: 0, msSinceBaseline: HOUR * 24 * 30 }) === null,
		"a document warm for 30 days with zero updates is not rebuilt",
	);
	assert(
		shouldRematerialize({ updatesSince: REMATERIALIZE_MIN_UPDATES - 1, msSinceBaseline: HOUR * 100 })
			=== null,
		"one update below the minimum is still not rebuilt",
	);
}

console.log("\n--- Test 4: precedence when both apply ---");
{
	// Reported reason must be the update threshold: it measures rope directly,
	// where age only proxies for it.  Collapsing these to a boolean would erase
	// the signal that says whether the threshold needs tuning.
	assert(
		shouldRematerialize({ updatesSince: REMATERIALIZE_UPDATE_THRESHOLD, msSinceBaseline: HOUR * 5 })
			=== "update-threshold",
		"update threshold wins over age when both are satisfied",
	);
}

console.log("\n--- Test 5: policy overrides ---");
{
	assert(
		shouldRematerialize({ updatesSince: 10, msSinceBaseline: 0 }, { updateThreshold: 10 })
			=== "update-threshold",
		"custom update threshold is honoured",
	);
	assert(
		shouldRematerialize({ updatesSince: 5, msSinceBaseline: 100 }, { maxAgeMs: 100, minUpdates: 5 })
			=== "age",
		"custom age and minimum are honoured",
	);
	assert(
		shouldRematerialize({ updatesSince: 4, msSinceBaseline: 100 }, { maxAgeMs: 100, minUpdates: 5 })
			=== null,
		"custom minimum still gates the age trigger",
	);
}

console.log("\n--- Test 6: degenerate inputs ---");
{
	assert(
		shouldRematerialize({ updatesSince: 0, msSinceBaseline: 0 }) === null,
		"a freshly rebuilt document is not immediately rebuilt again",
	);
	// A negative delta means the baseline was re-armed against a replaced
	// document; treat it as no progress rather than firing on it.
	assert(
		shouldRematerialize({ updatesSince: -5, msSinceBaseline: HOUR * 2 }) === null,
		"a negative update delta does not trigger a rebuild",
	);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) process.exit(1);
