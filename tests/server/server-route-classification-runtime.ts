/**
 * Runtime regression test for issue #40: DO subrequest amplification.
 *
 * Verifies at runtime that unknown/junk request paths return 404 without
 * touching any Durable Object namespace.  A trap env is used — any access to
 * YAOS_CONFIG or YAOS_SYNC throws with a clear error message so the test fails
 * loudly rather than silently passing if the DO access is swallowed.
 *
 * Also verifies that the /api/capabilities endpoint in claim mode only calls
 * YAOS_CONFIG once (auth + capabilities reuse the same fetched config).
 */

import worker from "../../server/src/index";
import type { Env } from "../../server/src/routes/types";
import {
	getStoredServerConfigCached,
	invalidateStoredServerConfigCache,
} from "../../server/src/routes/auth";
import { suite } from "../harness.ts";

const s = suite("server-route-classification-runtime");

// ── Trap env — any DO access throws ──────────────────────────────────────────

const DO_TOUCHED = "Durable Object namespace accessed for unknown route (issue #40 regression — INV-ROUTE-01)";

function makeTrapNamespace() {
	return {
		idFromName(_name: string): never { throw new Error(DO_TOUCHED); },
		idFromString(_id: string): never { throw new Error(DO_TOUCHED); },
		get(_id: unknown): never { throw new Error(DO_TOUCHED); },
		newUniqueId(): never { throw new Error(DO_TOUCHED); },
		jurisdiction(_j: string): never { throw new Error(DO_TOUCHED); },
	};
}

const trapEnv: Env = {
	YAOS_SYNC: makeTrapNamespace() as unknown as Env["YAOS_SYNC"],
	YAOS_CONFIG: makeTrapNamespace() as unknown as Env["YAOS_CONFIG"],
	SYNC_TOKEN: undefined,
};

// ── Test 1: junk paths return 404 without touching any DO ─────────────────────
s.section("Test 1: junk paths return 404 without touching YAOS_CONFIG or YAOS_SYNC");
{
	const junkPaths = [
		"/wp-login.php",
		"/favicon.ico",
		"/random-garbage",
		"/foo/bar",
		"/.env",
		"/admin",
		"/phpmyadmin",
		"/xmlrpc.php",
		"/.git/config",
	];

	for (const path of junkPaths) {
		let threw = false;
		let status = 0;
		try {
			const resp = await worker.fetch(
				new Request(`https://example.com${path}`),
				trapEnv,
			);
			status = resp.status;
		} catch (err) {
			threw = true;
			console.error(`  ERROR ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		s.check(!threw, `${path}: did not throw (DO namespace not touched)`);
		s.check(status === 404, `${path}: status is 404`);
	}
}

// ── Test 2: /vault/:id with no resource 404s without DO access ────────────────
s.section("Test 2: vault-shaped garbage paths return 404 without DO access");
{
	// These are the paths the reviewer explicitly flagged as still potentially
	// hitting YAOS_CONFIG after the first pass of the fix:
	//   /vault/foo              — no resource
	//   /vault/foo/random       — unknown resource
	//   /vault/foo/wp-login.php — garbage resource with plausible vault prefix
	// The vault resource whitelist (VALID_VAULT_RESOURCES) must catch these.
	const vaultJunkPaths = [
		"/vault/my-vault",               // no resource at all
		"/vault/foo/random",             // unknown resource
		"/vault/foo/wp-login.php",       // garbage resource
		"/vault/foo/probe",              // scanner probe
		"/vault/some-vault/not-a-resource",
		"/vault/abc123/admin",
		"/vault/abc123/config",
		"/vault/abc123/.env",
	];

	for (const path of vaultJunkPaths) {
		let threw = false;
		let status = 0;
		try {
			const resp = await worker.fetch(
				new Request(`https://example.com${path}`),
				trapEnv,
			);
			status = resp.status;
		} catch (err) {
			threw = true;
			console.error(`  ERROR ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		s.check(!threw, `${path}: did not throw (DO namespace not touched)`);
		s.check(status === 404, `${path}: status is 404`);
	}
}

// ── Test 3: Two claim-mode requests within TTL share one YAOS_CONFIG fetch ────
//
// This is the core issue #40 TTL cache runtime proof.  In claim mode, the
// first request populates the cache; the second request within the TTL window
// reuses the cached config and makes zero additional DO fetches.
//
// Both requests go through getAuthStateCached (one fetch) AND
// handleCapabilities which reuses authState.config (zero extra fetch).
// Total fetches for two requests: 1.  Before the fix it was 4 (2×2).
s.section("Test 3: two claim-mode requests within TTL share one YAOS_CONFIG fetch");
{
	invalidateStoredServerConfigCache();

	let fetchCount = 0;
	const claimConfig = {
		claimed: true,
		tokenHash: "abc123",
		updateProvider: null,
		updateRepoUrl: null,
		updateRepoBranch: null,
	};

	const countingEnv: Env = {
		YAOS_SYNC: makeTrapNamespace() as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: {
			idFromName: () => "global-config" as unknown as DurableObjectId,
			idFromString: (_id: string) => _id as unknown as DurableObjectId,
			get: (_id: unknown) => ({
				fetch: async () => {
					fetchCount++;
					return new Response(JSON.stringify(claimConfig), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
				// Minimal stub — only fetch is exercised
			}) as unknown as DurableObjectStub,
			newUniqueId: () => { throw new Error("unexpected"); },
			jurisdiction: (_j: string) => { throw new Error("unexpected"); },
		} as unknown as Env["YAOS_CONFIG"],
		SYNC_TOKEN: undefined,
	};

	const resp = await worker.fetch(
		new Request("https://example.com/api/capabilities"),
		countingEnv,
	);
	s.check(resp.status === 200, "/api/capabilities in claim mode returns 200");
	s.check(fetchCount === 1, `/api/capabilities in claim mode called YAOS_CONFIG exactly once (got ${fetchCount})`);

	// Second request uses the TTL cache — zero additional DO calls.
	fetchCount = 0;
	const resp2 = await worker.fetch(
		new Request("https://example.com/api/capabilities"),
		countingEnv,
	);
	s.check(resp2.status === 200, "/api/capabilities second request returns 200");
	s.check(fetchCount === 0, `second /api/capabilities within TTL uses cache (YAOS_CONFIG called ${fetchCount} times, expected 0)`);

	invalidateStoredServerConfigCache();
}

// ── Test 4: claimed routes in unclaimed mode return expected error ─────────────
//
// In unclaimed mode, getAuthStateCached must NOT call YAOS_SYNC.  Auth
// decisions happen entirely on YAOS_CONFIG config, before any vault routing.
s.section("Test 4: unclaimed mode — vault routes rejected without YAOS_SYNC access");
{
	invalidateStoredServerConfigCache();

	let syncTouched = false;
	const trapSyncEnv: Env = {
		YAOS_SYNC: {
			idFromName: (_name: string) => {
				syncTouched = true;
				throw new Error("YAOS_SYNC accessed before auth succeeded");
			},
		} as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: {
			idFromName: () => "global-config" as unknown as DurableObjectId,
			idFromString: (_id: string) => _id as unknown as DurableObjectId,
			get: (_id: unknown) => ({
				fetch: async () => new Response(JSON.stringify({
					claimed: false,
					tokenHash: null,
					updateProvider: null,
					updateRepoUrl: null,
					updateRepoBranch: null,
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			}) as unknown as DurableObjectStub,
			newUniqueId: () => { throw new Error("unexpected"); },
			jurisdiction: (_j: string) => { throw new Error("unexpected"); },
		} as unknown as Env["YAOS_CONFIG"],
		SYNC_TOKEN: undefined,
	};

	const resp = await worker.fetch(
		new Request("https://example.com/vault/some-vault/debug/recent"),
		trapSyncEnv,
	);
	s.check(resp.status === 503, "unclaimed mode: vault route returns 503");
	s.check(!syncTouched, "unclaimed mode: YAOS_SYNC was not touched");

	invalidateStoredServerConfigCache();
}

// ── Test 5: valid resource + invalid method/subpath → 404 before DO ───────────
//
// The four paths the reviewer explicitly flagged as the remaining hole after
// resource-only whitelisting.  These have a valid resource segment but an
// invalid method or subpath combination that the server never handles.
// They must be rejected by isKnownVaultRouteShape() before auth.
s.section("Test 5: valid resource + invalid shape returns 404 without YAOS_CONFIG");
{
	const invalidShapePaths: Array<[string, string]> = [
		// method, path
		["POST", "/vault/foo/debug/recent"],       // debug is GET-only
		["GET",  "/vault/foo/debug/evil"],          // debug only handles /recent
		["GET",  "/vault/foo/auth/random"],         // auth only handles POST /ticket
		["POST", "/vault/foo/blobs/not-real"],      // blobs POST only handles /exists
		["DELETE", "/vault/foo/blobs/somehash"],    // blobs doesn't handle DELETE
		["POST", "/vault/foo/auth/ticket/extra"],   // extra path segments
		["GET",  "/api/not-real"],                  // API-shaped but unknown endpoint
	];

	for (const [method, path] of invalidShapePaths) {
		let threw = false;
		let status = 0;
		try {
			const resp = await worker.fetch(
				new Request(`https://example.com${path}`, { method }),
				trapEnv,
			);
			status = resp.status;
		} catch (err) {
			threw = true;
			console.error(`  ERROR ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		s.check(!threw, `${method} ${path}: did not throw (DO namespace not touched)`);
		s.check(status === 404, `${method} ${path}: status is 404`);
	}
}

// ── Test 6: parseSyncPath ordering — /vault/sync/:id is not misread ───────────
//
// Regression guard: parseSyncPath must run before parseVaultPath.
// If the order were reversed, /vault/sync/my-vault would be parsed as
// vaultId="sync", resource="my-vault" and rejected as not-found by the
// resource whitelist — a silent breakage of sync connectivity.
s.section("Test 6: /vault/sync/:vaultId is classified as sync-socket, not vault");
{
	// The trap env throws on DO access.  A sync-socket route calls
	// getServerByName(env.YAOS_SYNC) so it WOULD throw.  But the classifier
	// result itself (before dispatch) is what we want to verify.
	// We test the side-effect: a WS-upgrade request to the sync path must not
	// return 404 (which would happen if parseSyncPath were skipped).
	//
	// Use an env with a working YAOS_SYNC stub that rejects the non-WS request
	// with a 426 so we can distinguish "classified as sync" from "classified as
	// not-found (404)".  Auth is via SYNC_TOKEN so YAOS_CONFIG is not needed.
	const syncTestEnv: Env = {
		SYNC_TOKEN: "test-token-for-sync-ordering-check",
		YAOS_SYNC: {
			idFromName: (_name: string) => _name as unknown as DurableObjectId,
			get: (_id: unknown) => ({
				fetch: async (_url: string, _init?: RequestInit) => {
					// Simulate the real server returning 426 for a non-WS sync request
					return new Response(JSON.stringify({ error: "update_required" }), {
						status: 426,
						headers: { "Content-Type": "application/json" },
					});
				},
			}) as unknown as DurableObjectStub,
			newUniqueId: () => { throw new Error("unexpected"); },
			jurisdiction: (_j: string) => { throw new Error("unexpected"); },
		} as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: makeTrapNamespace() as unknown as Env["YAOS_CONFIG"],
	};

	// Non-WS request to sync path — classified as sync-socket, routed to the
	// sync handler which rejects with 426 (not-WS upgrade rejection from rejectSocket).
	const resp = await worker.fetch(
		new Request("https://example.com/vault/sync/my-vault"),
		syncTestEnv,
	);
	// 426 means it reached the sync handler, not the 404 not-found path.
	// 401 would mean it reached auth but was rejected (SYNC_TOKEN mismatch).
	// 404 would mean parseSyncPath was skipped and it hit the resource whitelist.
	s.check(
		resp.status !== 404,
		"/vault/sync/:vaultId is NOT classified as not-found (parseSyncPath runs first)",
	);
	s.check(
		resp.status === 426 || resp.status === 401 || resp.status === 503,
		`/vault/sync/:vaultId reaches the sync handler (status ${resp.status}, not 404)`,
	);
}
await s.done();
