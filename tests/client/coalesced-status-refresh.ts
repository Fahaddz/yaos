import { CoalescedStatusRefresh } from "../../src/status/coalescedStatusRefresh";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function waitForTimers(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

console.log("\n--- Coalesced receipt status refresh ---");
let refreshCount = 0;
const refresh = new CoalescedStatusRefresh(() => {
	refreshCount++;
});

refresh.request();
refresh.request();
refresh.request();
assert(refreshCount === 0, "a requested refresh is deferred");
await waitForTimers();
assert(refreshCount === 1, "a burst of accepted receipt updates causes one redraw");

refresh.request();
refresh.cancel();
await waitForTimers();
assert(refreshCount === 1, "cancelling during teardown prevents a stale redraw");

refresh.request();
await waitForTimers();
assert(refreshCount === 2, "the coalescer accepts a later receipt update after rendering");

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
