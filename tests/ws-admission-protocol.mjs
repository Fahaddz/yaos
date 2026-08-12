import WebSocket from "ws";

const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";
const TOKEN = process.env.SYNC_TOKEN || "";
const BASE_VAULT_ID = process.env.YAOS_TEST_VAULT_ID || "yaos-ws-admission";
const ROOM_ID = `${BASE_VAULT_ID}-admission-protocol`;

if (!TOKEN) {
	throw new Error("SYNC_TOKEN is required for WebSocket admission protocol test");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

async function fetchTicket(vaultId) {
	const response = await fetch(`${HOST}/vault/${encodeURIComponent(vaultId)}/auth/ticket`, {
		method: "POST",
		headers: { Authorization: `Bearer ${TOKEN}` },
	});
	if (!response.ok) {
		throw new Error(`ticket fetch failed (${response.status}): ${await response.text()}`);
	}
	const body = await response.json();
	if (typeof body?.ticket !== "string") {
		throw new Error(`ticket response was malformed: ${JSON.stringify(body)}`);
	}
	return body.ticket;
}

function socketUrl(vaultId, params) {
	const url = new URL(HOST);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `/vault/sync/${encodeURIComponent(vaultId)}`;
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function captureSocket(url, { settleAfterOpenMs = null } = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const socket = new WebSocket(url);
		const messages = [];
		let opened = false;
		let upgradeStatus = null;
		let settled = false;
		const timeout = setTimeout(() => {
			finish(new Error(`timed out waiting for socket outcome: ${url}`));
			socket.terminate();
		}, 10_000);

		function finish(value) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (value instanceof Error) rejectPromise(value);
			else resolvePromise(value);
		}

		socket.once("upgrade", (response) => {
			upgradeStatus = response.statusCode;
		});
		socket.once("open", () => {
			opened = true;
			if (settleAfterOpenMs !== null) {
				setTimeout(() => {
					// A healthy PartyServer socket is intentionally long-lived. Verify
					// it stayed open without a fatal worker frame, then terminate only
					// the test client instead of waiting for a server close that should
					// never occur during normal sync.
					finish({ opened, upgradeStatus, messages, closeCode: null, closeReason: null });
					socket.terminate();
				}, settleAfterOpenMs);
			}
		});
		socket.on("message", (message) => messages.push(message.toString()));
		socket.once("unexpected-response", (_request, response) => {
			finish(new Error(`unexpected HTTP response ${response.statusCode} for ${url}`));
		});
		socket.once("error", (error) => finish(error));
		socket.once("close", (code, reason) => {
			finish({ opened, upgradeStatus, messages, closeCode: code, closeReason: reason.toString() });
		});
	});
}

function assertFatalUpdateResponse(result, expectedCode, expectedReason) {
	assert(result.upgradeStatus === 101, `rejection upgrades with HTTP 101 (got ${result.upgradeStatus})`);
	assert(result.opened, "rejection opens the WebSocket before sending fatal frames");
	assert(result.closeCode === 1008, `rejection closes with policy-violation 1008 (got ${result.closeCode})`);
	assert(result.closeReason === expectedReason, `rejection close reason is ${expectedReason}`);
	assert(result.messages.length === 2, `rejection sends exactly two fatal frames (got ${result.messages.length})`);
	const payload = JSON.parse(result.messages[0]);
	assert(payload.type === "error", "first fatal frame is a generic error payload");
	assert(payload.code === expectedCode, `first fatal frame code is ${expectedCode}`);
	assert(result.messages[1] === `__YPS:${result.messages[0]}`, "second fatal frame is the y-partyserver control form");
	return payload;
}

console.log("\n--- WebSocket protocol: authenticated out-of-range schema ---");
{
	const ticket = await fetchTicket(ROOM_ID);
	const result = await captureSocket(socketUrl(ROOM_ID, {
		ticket,
		schemaVersion: "4",
	}));
	const payload = assertFatalUpdateResponse(result, "update_required", "update required");
	assert(payload.reason === "client_schema_unsupported", "schema rejection reports the explicit unsupported-client reason");
	assert(payload.clientSchemaVersion === 4, "schema rejection echoes the client schema");
	assert(payload.minSchemaVersion === 1 && payload.maxSchemaVersion === 3, "schema rejection publishes the supported 1..3 envelope");
}

console.log("\n--- WebSocket protocol: authentication precedes out-of-range schema ---");
{
	const result = await captureSocket(socketUrl(ROOM_ID, { schemaVersion: "4" }));
	const payload = assertFatalUpdateResponse(result, "unauthorized", "unauthorized");
	assert(payload.reason === undefined, "auth rejection does not disclose schema-range details");
	assert(payload.minSchemaVersion === undefined && payload.maxSchemaVersion === undefined, "auth rejection omits schema envelope details");
}

console.log("\n--- WebSocket protocol: supported ticket-authenticated schema upgrades normally ---");
{
	const ticket = await fetchTicket(ROOM_ID);
	const result = await captureSocket(socketUrl(ROOM_ID, {
		ticket,
		schemaVersion: "2",
	}), { settleAfterOpenMs: 250 });
	assert(result.upgradeStatus === 101, `supported connection upgrades with HTTP 101 (got ${result.upgradeStatus})`);
	assert(result.opened, "supported connection opens");
	assert(
		!result.messages.some((message) => {
			try {
				return JSON.parse(message)?.type === "error";
			} catch {
				return false;
			}
		}),
		"supported connection receives no worker fatal error payload",
	);
}

console.log("\n✓ WebSocket admission protocol tests passed");
