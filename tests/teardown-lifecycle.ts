import {
	RuntimeTeardownCoordinator,
	runTeardownStages,
	TeardownStagesError,
} from "../src/runtime/teardownLifecycle";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

console.log("\n--- Teardown lifecycle ---");

{
	const lifecycle = new RuntimeTeardownCoordinator();
	const initialGeneration = lifecycle.beginInitialization();
	assert(initialGeneration !== null, "initialization starts while the lifecycle is open");
	assert(
		initialGeneration !== null && lifecycle.isInitializationCurrent(initialGeneration),
		"current initialization generation is accepted before teardown",
	);

	let teardownRuns = 0;
	let releaseTeardown: (() => void) | null = null;
	const teardownBarrier = new Promise<void>((resolve) => {
		releaseTeardown = resolve;
	});
	const first = lifecycle.beginTeardown(async () => {
		teardownRuns++;
		await teardownBarrier;
	});
	const second = lifecycle.beginTeardown(async () => {
		teardownRuns++;
	});

	assert(first === second, "concurrent teardown callers receive one retained promise");
	assert(teardownRuns === 1, "concurrent teardown callers do not run cleanup twice");
	assert(lifecycle.isClosing, "teardown closes the lifecycle synchronously");
	assert(!lifecycle.reopenAfterTeardown(), "reset cannot reopen while teardown is still pending");
	assert(lifecycle.beginInitialization() === null, "closing gate rejects late initialization");
	assert(
		initialGeneration !== null && !lifecycle.isInitializationCurrent(initialGeneration),
		"closing invalidates an in-flight initialization generation",
	);

	releaseTeardown?.();
	await first;
	assert(lifecycle.beginTeardown(async () => { teardownRuns++; }) === first, "settled teardown promise remains retained");
	assert(teardownRuns === 1, "retained settled promise still prevents duplicate teardown");
	assert(lifecycle.reopenAfterTeardown(), "intentional reset can reopen a completed teardown");
	const restartedGeneration = lifecycle.beginInitialization();
	assert(restartedGeneration !== null, "reopened lifecycle permits reset initialization");

	lifecycle.requestPermanentShutdown();
	assert(lifecycle.beginInitialization() === null, "permanent unload gate rejects initialization");
	assert(!lifecycle.reopenAfterTeardown(), "permanent unload cannot be reopened by reset logic");
}

{
	const lifecycle = new RuntimeTeardownCoordinator();
	const order: string[] = [];
	let releaseStartup: (() => void) | null = null;
	const startupBlocked = new Promise<void>((resolve) => {
		releaseStartup = resolve;
	});
	const staleStartup = (async (): Promise<void> => {
		const generation = lifecycle.beginInitialization();
		if (generation === null) return;
		order.push("startup-waiting");
		await startupBlocked;
		if (!lifecycle.isInitializationCurrent(generation)) {
			order.push("startup-aborted");
			return;
		}
		order.push("startup-published-runtime");
	})();

	await Promise.resolve();
	await lifecycle.beginTeardown(async () => {
		order.push("teardown-complete");
	});
	releaseStartup?.();
	await staleStartup;
	assert(
		order.join(",") === "startup-waiting,teardown-complete,startup-aborted",
		"startup released after teardown cannot publish a stale runtime",
	);
}

{
	const order: string[] = [];
	const reports: string[] = [];
	let thrown: unknown = null;
	try {
		await runTeardownStages([
			{ name: "disk-pending-writes", run: () => { order.push("disk-pending-writes"); } },
			{
				name: "disk-index-persistence",
				run: () => {
					order.push("disk-index-persistence");
					throw new Error("disk index unavailable");
				},
			},
			{ name: "attachments", run: () => { order.push("attachments"); } },
			{ name: "connection-controller", run: () => { order.push("connection-controller"); } },
			{ name: "vault-sync", run: () => { order.push("vault-sync"); } },
		], ({ stage }) => reports.push(stage));
	} catch (error) {
		thrown = error;
	}

	assert(
		order.join(",") === "disk-pending-writes,disk-index-persistence,attachments,connection-controller,vault-sync",
		"teardown preserves stage ordering while continuing after a failure",
	);
	assert(reports.join(",") === "disk-index-persistence", "stage failure is reported when it occurs");
	assert(thrown instanceof TeardownStagesError, "teardown rejects after all stages with aggregate failure context");
	assert(
		thrown instanceof TeardownStagesError && thrown.failures.length === 1 && thrown.failures[0]?.stage === "disk-index-persistence",
		"aggregate failure identifies the failed stage",
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
