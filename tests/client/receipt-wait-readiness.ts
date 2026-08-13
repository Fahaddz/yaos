/**
 * Receipt wait readiness regression tests.
 *
 * These are pure state tests: no Obsidian, sockets, timers, or Yjs.
 */

import {
	isReceiptWaitReadyAfter,
	isReceiptWaitReadyAfterCheckpoint,
	type ReceiptWaitCheckpoint,
	type ReceiptWaitState,
} from "../../qa/harness/receiptWaitReadiness";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

function receipt(overrides: Partial<ReceiptWaitState>): ReceiptWaitState {
	return {
		candidateId: null,
		capturedAt: null,
		lastConfirmedCandidateId: null,
		lastConfirmedAt: null,
		hasUnconfirmedCandidate: false,
		...overrides,
	};
}

function checkpoint(overrides: Partial<ReceiptWaitCheckpoint>): ReceiptWaitCheckpoint {
	return {
		checkpointAt: 100,
		candidateId: null,
		candidateWasUnconfirmed: false,
		...overrides,
	};
}

console.log("\n--- Receipt wait readiness ---");

{
	const ready = isReceiptWaitReadyAfter(100, receipt({
		candidateId: "candidate-b",
		capturedAt: 110,
		lastConfirmedCandidateId: "candidate-a",
		lastConfirmedAt: 120,
		hasUnconfirmedCandidate: true,
	}));
	assert(!ready, "historical A confirmation cannot satisfy pending B");
}

{
	const ready = isReceiptWaitReadyAfter(100, receipt({
		candidateId: "candidate-b",
		capturedAt: 110,
		lastConfirmedCandidateId: "candidate-b",
		lastConfirmedAt: 120,
		hasUnconfirmedCandidate: false,
	}));
	assert(ready, "matching B confirmation satisfies the candidate-ID proof");
}

{
	const ready = isReceiptWaitReadyAfter(100, receipt({
		lastConfirmedAt: 120,
		hasUnconfirmedCandidate: false,
	}));
	assert(!ready, "timestamp-only confirmation never satisfies an action-relative wait");
}

{
	const ready = isReceiptWaitReadyAfter(100, receipt({
		candidateId: "candidate-b",
		capturedAt: 100,
		lastConfirmedCandidateId: "candidate-b",
		lastConfirmedAt: 120,
		hasUnconfirmedCandidate: false,
	}));
	assert(!ready, "strict waits reject a candidate captured at the boundary");
}

console.log("\n--- Receipt checkpoint readiness ---");

{
	const ready = isReceiptWaitReadyAfterCheckpoint(
		checkpoint({ candidateId: "candidate-pending", candidateWasUnconfirmed: true }),
		receipt({
			candidateId: "candidate-pending",
			capturedAt: 90,
			lastConfirmedCandidateId: "candidate-pending",
			lastConfirmedAt: 110,
			hasUnconfirmedCandidate: false,
		}),
	);
	assert(ready, "a candidate pending at checkpoint can confirm after it");
}

{
	const ready = isReceiptWaitReadyAfterCheckpoint(
		checkpoint({ candidateId: "candidate-confirmed", candidateWasUnconfirmed: false }),
		receipt({
			candidateId: "candidate-confirmed",
			capturedAt: 90,
			lastConfirmedCandidateId: "candidate-confirmed",
			lastConfirmedAt: 200,
			hasUnconfirmedCandidate: false,
		}),
	);
	assert(!ready, "an already-confirmed candidate or delayed duplicate echo cannot pass");
}

{
	const ready = isReceiptWaitReadyAfterCheckpoint(
		checkpoint({ candidateId: "candidate-old", candidateWasUnconfirmed: false }),
		receipt({
			candidateId: "candidate-new",
			capturedAt: 101,
			lastConfirmedCandidateId: "candidate-new",
			lastConfirmedAt: 110,
			hasUnconfirmedCandidate: false,
		}),
	);
	assert(ready, "a new candidate captured after checkpoint can confirm");
}

{
	const ready = isReceiptWaitReadyAfterCheckpoint(
		checkpoint({ candidateId: "candidate-pending", candidateWasUnconfirmed: true }),
		receipt({
			candidateId: "candidate-pending",
			capturedAt: 90,
			lastConfirmedCandidateId: "candidate-other",
			lastConfirmedAt: 110,
			hasUnconfirmedCandidate: false,
		}),
	);
	assert(!ready, "a mismatched confirmation candidate cannot pass a checkpoint wait");
}

{
	const ready = isReceiptWaitReadyAfterCheckpoint(
		checkpoint({ candidateId: "candidate-old", candidateWasUnconfirmed: false }),
		receipt({
			candidateId: "candidate-new",
			capturedAt: 100,
			lastConfirmedCandidateId: "candidate-new",
			lastConfirmedAt: 110,
			hasUnconfirmedCandidate: false,
		}),
	);
	assert(!ready, "checkpoint waits reject a new candidate captured at the strict boundary");
}

{
	const ready = isReceiptWaitReadyAfterCheckpoint(
		// Candidate IDs are not persisted, so a checkpoint after restore can be id-less.
		checkpoint({ candidateId: null, candidateWasUnconfirmed: false }),
		receipt({
			candidateId: "candidate-after-restore",
			capturedAt: 101,
			lastConfirmedCandidateId: "candidate-after-restore",
			lastConfirmedAt: 110,
			hasUnconfirmedCandidate: false,
		}),
	);
	assert(!ready, "an id-less restored checkpoint fails closed despite a later confirmed candidate");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
