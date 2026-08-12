// Regression tests for the enriched status bar label derivation (Phase 1.5 / INV-AUTH-01).
//
// The old path collapses ConnectionState into 7 coarse SyncStatus values and then
// maps those to display strings. That loses the auth rejection reason code and the
// schema-mismatch detail. The new getLabelFromConnectionState() maps directly from
// the rich ConnectionState, giving the user enough context to act without a dashboard.
//
// Invariants verified:
//   - each ConnectionState kind produces a distinct, readable label
//   - auth_failed variants expose the specific reason, not a generic "Unauthorized"
//   - server_update_required is "Update required", not "Error"
//   - transferStatus is appended when present

import {
	getLabelFromConnectionState,
	getServerReceiptStatusLabel,
	SERVER_RECEIPT_STATUS_TITLE,
	SERVER_RECEIPT_STATUS_TITLE_LEGACY,
	getServerReceiptStatusTitle,
} from "../src/status/statusBarController";
import type { ConnectionState } from "../src/runtime/connectionController";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function label(state: ConnectionState, transfer?: string): string {
	return getLabelFromConnectionState(state, transfer);
}

console.log("\n--- Test 1: baseline connection state labels use YAOS: prefix ---");
assert(label({ kind: "disconnected" }).startsWith("YAOS:"), "disconnected starts with YAOS:");
assert(label({ kind: "loading_cache" }).startsWith("YAOS:"), "loading_cache starts with YAOS:");
assert(label({ kind: "connecting" }).startsWith("YAOS:"), "connecting starts with YAOS:");
assert(label({ kind: "online", generation: 1 }).startsWith("YAOS:"), "online starts with YAOS:");
assert(label({ kind: "offline", reason: "provider_disconnected", generation: 1 }).startsWith("YAOS:"), "offline starts with YAOS:");
assert(label({ kind: "disconnected" }).includes("Disconnected"), "disconnected label readable");
assert(label({ kind: "loading_cache" }).includes("Loading"), "loading_cache label readable");
assert(label({ kind: "connecting" }).includes("Connecting"), "connecting label readable");
assert(label({ kind: "online", generation: 1 }).includes("Connected"), "online label readable");
assert(label({ kind: "offline", reason: "provider_disconnected", generation: 1 }).includes("Offline"), "offline label readable");

console.log("\n--- Test 2: auth_failed reason codes are exposed ---");
assert(
	label({ kind: "auth_failed", code: "unauthorized" }).includes("Auth rejected"),
	"unauthorized shows 'Auth rejected' not generic Unauthorized",
);
assert(
	label({ kind: "auth_failed", code: "unclaimed" }).includes("unclaimed"),
	"unclaimed reason is visible",
);
assert(
	label({ kind: "auth_failed", code: "server_misconfigured" }).includes("misconfigured"),
	"server_misconfigured reason is visible",
);
// All three are distinct
assert(
	label({ kind: "auth_failed", code: "unauthorized" }) !==
		label({ kind: "auth_failed", code: "unclaimed" }),
	"unauthorized and unclaimed produce different labels",
);
assert(
	label({ kind: "auth_failed", code: "unclaimed" }) !==
		label({ kind: "auth_failed", code: "server_misconfigured" }),
	"unclaimed and server_misconfigured produce different labels",
);

console.log("\n--- Test 3: server_update_required is not 'Error' ---");
const updateRequiredLabel = label({
	kind: "server_update_required",
	details: { clientSchemaVersion: 1, roomSchemaVersion: 2, reason: null },
});
assert(updateRequiredLabel.includes("Update required"), "server_update_required shows 'Update required'");
assert(!updateRequiredLabel.toLowerCase().includes("error"), "server_update_required does not say 'Error'");

console.log("\n--- Test 4: transferStatus is appended when present ---");
const withTransfer = label({ kind: "online", generation: 1 }, "↑ 3 files");
assert(withTransfer.includes("↑ 3 files"), "transferStatus appended");
assert(withTransfer.includes("Connected"), "base label present with transfer");

const withoutTransfer = label({ kind: "online", generation: 1 }, null);
assert(!withoutTransfer.includes("null"), "null transferStatus not rendered");

console.log("\n--- Test 4b: server receipt status labels distinguish current and historical facts ---");
const receiptBase = {
	lastServerReceiptEchoAt: null,
	lastKnownServerReceiptEchoAt: null,
	candidatePersistenceHealthy: true,
	serverReceiptStartupValidation: "validated",
};
const observedAt = Date.UTC(2026, 4, 10, 12, 34);
const observedTime = new Date(observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
assert(
	getServerReceiptStatusLabel({ ...receiptBase, serverAppliedLocalState: true }, true) ===
		"Receipt: server received latest local state",
	"connected + true identifies the latest local state as received by the server",
);
assert(
	getServerReceiptStatusLabel({ ...receiptBase, serverAppliedLocalState: false }, true) ===
		"Receipt: local state not yet received by server",
	"connected + false identifies the local state as not yet received",
);
assert(
	getServerReceiptStatusLabel({ ...receiptBase, serverAppliedLocalState: false }, false) ===
		"Receipt: offline — local state not yet received by server",
	"offline + false retains the current local-state warning",
);
assert(
	getServerReceiptStatusLabel({ ...receiptBase, serverAppliedLocalState: true, lastServerReceiptEchoAt: observedAt }, false) ===
		`Receipt: offline — server receipt at ${observedTime}`,
	"offline + current-session echo identifies when the server receipt was observed",
);
assert(
	getServerReceiptStatusLabel(
		{ ...receiptBase, serverAppliedLocalState: true, lastServerReceiptEchoAt: observedAt, receiptGuaranteeIsDurable: true },
		false,
	) === `Receipt: offline — server saved at ${observedTime}`,
	"offline + durable marker reports when the write landed, not merely an echo",
);
assert(
	getServerReceiptStatusLabel({
		...receiptBase,
		serverAppliedLocalState: null,
		lastKnownServerReceiptEchoAt: observedAt,
	}, true) === `Receipt: last known server receipt at ${observedTime} — checking…`,
	"historical receipt is explicitly marked as last known while current state is checked",
);
assert(
	getServerReceiptStatusLabel({
		...receiptBase,
		serverAppliedLocalState: null,
		serverReceiptStartupValidation: "skipped_local_yjs_timeout",
	}, true) === "Receipt: unchecked — local cache still loading",
	"startup validation skip is stated without claiming a server result",
);
assert(
	getServerReceiptStatusLabel({ ...receiptBase, serverAppliedLocalState: null }, true) === "Receipt: not tracked yet",
	"unknown receipt without history is not tracked yet",
);
assert(
	getServerReceiptStatusLabel({ ...receiptBase, serverAppliedLocalState: true, candidatePersistenceHealthy: false }, true) ===
		"Receipt: server received latest local state — receipt history not saved locally",
	"receipt-history persistence degradation is stated precisely",
);
const receiptStatus = getLabelFromConnectionState(
	{ kind: "online", generation: 1 },
	null,
	{ ...receiptBase, serverAppliedLocalState: true },
);
assert(receiptStatus.includes("Receipt:"), "connection label includes receipt label when facts are provided");
// The receipt never implies DELIVERY, in either guarantee level.  "Saved" is no
// longer banned outright: against a server that reports storage confirmation it
// is simply true, and the old blanket ban would force the UI to understate a
// guarantee it actually has.
assert(
	!/Synced|Confirmed|Acked|all devices|other devices/i.test(receiptStatus),
	"receipt label never claims delivery to other devices",
);
assert(
	!/Saved|Durable/i.test(receiptStatus),
	"without a durability marker the label does not claim a durable write",
);

const durableReceipt = getLabelFromConnectionState(
	{ kind: "online", generation: 1 },
	null,
	{ ...receiptBase, serverAppliedLocalState: true, receiptGuaranteeIsDurable: true },
);
assert(
	/saved/i.test(durableReceipt),
	"with a durability marker the label reports the write, not merely receipt",
);
assert(
	!/Synced|all devices|other devices/i.test(durableReceipt),
	"the durable label still does not claim delivery",
);

assert(
	getServerReceiptStatusTitle({ ...receiptBase, receiptGuaranteeIsDurable: true }) ===
		"Server receipt means this device’s latest local CRDT state was written to the server’s storage. It does not prove that another device received the change.",
	"durable tooltip claims the write and still disclaims delivery",
);
assert(
	getServerReceiptStatusTitle(receiptBase) === SERVER_RECEIPT_STATUS_TITLE_LEGACY,
	"a server without the marker falls back to the in-memory wording",
);
assert(
	/does not prove durable storage/.test(SERVER_RECEIPT_STATUS_TITLE_LEGACY)
	&& !/does not prove durable storage/.test(SERVER_RECEIPT_STATUS_TITLE),
	"the non-durable disclaimer survives only on the legacy wording",
);
const errorWithReceipt = getLabelFromConnectionState(
	{ kind: "auth_failed", code: "unauthorized" },
	null,
	{ ...receiptBase, serverAppliedLocalState: true },
);
assert(!errorWithReceipt.includes("Receipt:"), "auth/error labels omit receipt suffix");

console.log("\n--- Test 5: every ConnectionState kind produces a distinct YAOS: label ---");
const allStates: ConnectionState[] = [
	{ kind: "disconnected" },
	{ kind: "loading_cache" },
	{ kind: "connecting" },
	{ kind: "online", generation: 1 },
	{ kind: "offline", reason: "provider_disconnected", generation: 1 },
	{ kind: "auth_failed", code: "unauthorized" },
	{ kind: "auth_failed", code: "unclaimed" },
	{ kind: "auth_failed", code: "server_misconfigured" },
	{ kind: "server_update_required", details: { clientSchemaVersion: 1, roomSchemaVersion: 2, reason: null } },
];
const seen = new Set<string>();
for (const state of allStates) {
	const l = label(state);
	assert(l.startsWith("YAOS:"), `label for ${state.kind} starts with "YAOS:" (not "CRDT:")`);
	assert(!l.includes("CRDT"), `label for ${state.kind} does not contain implementation detail "CRDT"`);
	assert(l.length > 6, `label for ${state.kind} has content`);
	assert(!seen.has(l), `label for ${state.kind} is distinct from previous labels`);
	seen.add(l);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
