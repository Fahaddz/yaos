/**
 * The single pinned CRDT schema version, for plain-node (.mjs) test suites.
 *
 * The live-worker suites run under bare `node`, so they cannot import the
 * TypeScript constant in src/sync/schema.ts. Rather than keep hardcoded copies
 * that silently rot at the next schema bump, the value is read out of the real
 * source at load time with the same regex scripts/guard-schema-version.mjs
 * uses; that guard separately asserts the server pin in server/src/version.ts
 * equals this value.
 */

import { readFileSync } from "node:fs";

const SCHEMA_SOURCE_URL = new URL("../src/sync/schema.ts", import.meta.url);
const match = /export const SCHEMA_VERSION\s*=\s*(\d+)/.exec(
	readFileSync(SCHEMA_SOURCE_URL, "utf8"),
);

if (!match) {
	throw new Error(
		"could not read SCHEMA_VERSION from src/sync/schema.ts — run scripts/guard-schema-version.mjs",
	);
}

export const PINNED_SCHEMA_VERSION = Number(match[1]);
