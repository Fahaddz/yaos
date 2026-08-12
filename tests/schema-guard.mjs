/**
 * Live-worker admission test for the pinned schema version.
 *
 * The server admits exactly one schema version (SERVER_MIN/MAX_SCHEMA_VERSION
 * in server/src/version.ts, equal to SCHEMA_VERSION in src/sync/schema.ts).
 * This suite proves, against a real Worker, that:
 *   - a client at the pinned version connects and syncs;
 *   - a client below the pin is rejected with update_required;
 *   - a client above the pin is rejected with update_required;
 *   - a client that declares no schema at all is rejected (no legacy default).
 *
 * The room-skew rejections (client_schema_older_than_room /
 * client_schema_newer_than_room) are deliberately not exercised here: the
 * envelope check runs before the room probe, so a room at any other version can
 * no longer be created by a client. That check is defense-in-depth for a room
 * left behind by a rolled-back server, and is covered by
 * tests/meta-v3-schema-gate-and-stats.ts.
 */

import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { PINNED_SCHEMA_VERSION } from "./pinned-schema-version.mjs";

const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";
const TOKEN = process.env.SYNC_TOKEN || "";
const BASE_VAULT_ID = process.env.YAOS_TEST_VAULT_ID || "yaos-schema-guard";
const ROOM_PREFIX = `${BASE_VAULT_ID}-schema-guard`;

if (!TOKEN) {
	throw new Error("SYNC_TOKEN is required for schema-guard test");
}

function wait(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function buildWsUrl(roomId, { includeSchema, schemaVersion }) {
	const url = new URL(`/vault/sync/${encodeURIComponent(roomId)}`, HOST);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("token", TOKEN);
	if (includeSchema && schemaVersion !== undefined) {
		url.searchParams.set("schemaVersion", String(schemaVersion));
	}
	return url.toString();
}

async function safeDestroy(provider, ydoc) {
	// Force terminate the WebSocket to skip the 30s close handshake timeout in "ws" library.
	const ws = provider.ws;
	if (ws && typeof ws.terminate === "function") {
		ws.terminate();
	}

	// Ensure Awareness interval is cleared (using public API).
	if (provider.awareness) {
		provider.awareness.destroy();
	}

	const capturedDuringTeardown = new Set();
	const originalSetTimeout = globalThis.setTimeout;
	const originalGlobalSetTimeout = global.setTimeout;
	const patchedSetTimeout = (fn, delay, ...args) => {
		const handle = originalSetTimeout(fn, delay, ...args);
		if (delay > 0) {
			capturedDuringTeardown.add(handle);
		}
		return handle;
	};
	globalThis.setTimeout = patchedSetTimeout;
	global.setTimeout = patchedSetTimeout;

	provider.destroy();
	if (ydoc) ydoc.destroy();

	// Give a few ticks for any post-close logic (like reconnect timers)
	await new Promise((r) => originalSetTimeout(r, 100));

	globalThis.setTimeout = originalSetTimeout;
	global.setTimeout = originalGlobalSetTimeout;

	for (const h of capturedDuringTeardown) {
		clearTimeout(h);
	}
}

async function seedRoomSchema(roomId, schemaVersion) {
	const ydoc = new Y.Doc();
	const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;

	const provider = new YSyncProvider(HOST, roomId, ydoc, {
		prefix: syncPrefix,
		params: {
			token: TOKEN,
			schemaVersion: String(schemaVersion),
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});

	await new Promise((resolvePromise, rejectPromise) => {
		let done = false;
		const timeout = setTimeout(() => {
			if (done) return;
			done = true;
			rejectPromise(new Error("Timed out while seeding schema version"));
		}, 10_000);

		const finish = (err) => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		provider.on("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (msg?.type === "error") {
					finish(new Error(`Seeding rejected by server: ${msg.code}`));
				}
			} catch {
				// Not JSON, ignore.
			}
		});

		provider.on("sync", (synced) => {
			if (!synced) return;
			const sys = ydoc.getMap("sys");
			ydoc.transact(() => {
				sys.set("initialized", true);
				sys.set("schemaVersion", schemaVersion);
			});

			// Give the provider a moment to flush the update.
			void wait(500).then(() => finish());
		});
	});

	await safeDestroy(provider, ydoc);
}

async function expectRejected(label, wsUrl, expectedReason) {
	let payload = null;
	await new Promise((resolvePromise, rejectPromise) => {
		const ws = new WebSocket(wsUrl);
		let sawExpectedCode = false;
		let sawExpectedReason = false;
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (typeof ws.terminate === "function") ws.terminate();
			else ws.close();
			rejectPromise(new Error(`${label}: timed out waiting for update_required`));
		}, 5_000);

		const finish = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (typeof ws.terminate === "function") ws.terminate();
			else ws.close();
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		ws.on("message", (data) => {
			const text = typeof data === "string" ? data : data.toString();
			try {
				const msg = JSON.parse(text);
				if (msg?.type === "error" && msg?.code === "update_required") {
					sawExpectedCode = true;
					sawExpectedReason = msg.reason === expectedReason;
					payload = msg;
				}
			} catch {
				// ignore non-json
			}
		});

		ws.on("close", () => {
			if (!sawExpectedCode || !sawExpectedReason) {
				finish(new Error(
					`${label}: socket closed without update_required/${expectedReason} error` +
					(payload ? ` (got reason ${JSON.stringify(payload.reason)})` : ""),
				));
				return;
			}
			finish();
		});

		ws.on("error", (err) => {
			finish(err);
		});
	});
	return payload;
}

async function expectAllowed(roomId, schemaVersion) {
	const ydoc = new Y.Doc();
	const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;
	const provider = new YSyncProvider(HOST, roomId, ydoc, {
		prefix: syncPrefix,
		params: {
			token: TOKEN,
			schemaVersion: String(schemaVersion),
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});

	await new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectPromise(new Error("Compatible schema client failed to sync in time"));
		}, 10_000);

		const finish = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		provider.on("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (msg?.type === "error") {
					finish(new Error(`Compatible schema client was rejected: ${msg.code}`));
				}
			} catch {
				// Not JSON, ignore.
			}
		});

		provider.on("sync", (synced) => {
			if (synced) finish();
		});
	});

	await safeDestroy(provider, ydoc);
}

async function main() {
	const roomId = `${ROOM_PREFIX}-room-v${PINNED_SCHEMA_VERSION}`;

	await seedRoomSchema(roomId, PINNED_SCHEMA_VERSION);
	console.log(`Seeded ${roomId} with sys.schemaVersion=${PINNED_SCHEMA_VERSION}`);

	await expectAllowed(roomId, PINNED_SCHEMA_VERSION);
	console.log(`Accepted client at the pinned schema v${PINNED_SCHEMA_VERSION}`);

	for (const clientSchemaVersion of [PINNED_SCHEMA_VERSION - 1, PINNED_SCHEMA_VERSION + 1]) {
		const payload = await expectRejected(
			`client v${clientSchemaVersion} is outside the pinned schema`,
			buildWsUrl(roomId, { includeSchema: true, schemaVersion: clientSchemaVersion }),
			"client_schema_unsupported",
		);
		if (payload.clientSchemaVersion !== clientSchemaVersion) {
			throw new Error(`rejection did not echo client schema v${clientSchemaVersion}: ${JSON.stringify(payload)}`);
		}
		if (
			payload.minSchemaVersion !== PINNED_SCHEMA_VERSION ||
			payload.maxSchemaVersion !== PINNED_SCHEMA_VERSION
		) {
			throw new Error(`rejection did not publish the pinned envelope: ${JSON.stringify(payload)}`);
		}
		console.log(`Rejected client v${clientSchemaVersion} with client_schema_unsupported`);
	}

	// No legacy default: an undeclared schema is an unknown writer, not a v1 one.
	const undeclared = await expectRejected(
		"client that declares no schema",
		buildWsUrl(roomId, { includeSchema: false }),
		"invalid_client_schema",
	);
	if (undeclared.clientSchemaVersion !== null) {
		throw new Error(`undeclared-schema rejection should report a null client schema: ${JSON.stringify(undeclared)}`);
	}
	console.log("Rejected client with no schemaVersion param (invalid_client_schema)");

	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
