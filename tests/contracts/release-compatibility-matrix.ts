import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityUpdateService } from "../../src/runtime/capabilityUpdateService";
import type { ServerCapabilities } from "../../src/sync/serverCapabilities";
import type { UpdateManifest } from "../../src/update/updateManifest";
import { SCHEMA_VERSION } from "../../src/sync/schema";
import {
	SERVER_MAX_SCHEMA_VERSION,
	SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER,
	SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN,
	SERVER_MIN_SCHEMA_VERSION,
	SERVER_RECOMMENDED_PLUGIN_VERSION,
	SERVER_VERSION,
} from "../../server/src/version";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")) as {
	version: string;
	minAppVersion: string;
};
const versions = JSON.parse(readFileSync(resolve(root, "versions.json"), "utf8")) as Record<string, string>;

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

function parseVersion(value: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, minimum: string): boolean {
	const actualParts = parseVersion(actual);
	const minimumParts = parseVersion(minimum);
	if (!actualParts || !minimumParts) return false;
	for (let i = 0; i < actualParts.length; i++) {
		if (actualParts[i]! > minimumParts[i]!) return true;
		if (actualParts[i]! < minimumParts[i]!) return false;
	}
	return true;
}

console.log("\n--- Release compatibility matrix ---");

assert(packageJson.version === manifest.version, "package.json and manifest.json publish the same plugin version");
assert(versions[manifest.version] === manifest.minAppVersion, "versions.json contains the release plugin version and minimum Obsidian version");
assert(parseVersion(SERVER_VERSION) !== null, "server version is numeric semver");
assert(atLeast(SERVER_VERSION, SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN), "current server satisfies the plugin's advertised server floor");
assert(atLeast(packageJson.version, SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER), "current plugin satisfies the server's advertised plugin floor");
assert(atLeast(packageJson.version, SERVER_RECOMMENDED_PLUGIN_VERSION), "current plugin meets the server recommendation");
assert(
	SERVER_MIN_SCHEMA_VERSION === SERVER_MAX_SCHEMA_VERSION,
	"server publishes a single pinned schema version (min === max)",
);
assert(SERVER_MAX_SCHEMA_VERSION === SCHEMA_VERSION, "the pinned server schema equals the current plugin schema");
for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
	assert(
		version !== SERVER_MIN_SCHEMA_VERSION && version !== SERVER_MAX_SCHEMA_VERSION,
		`schema v${version} is not admitted by the pinned server`,
	);
}

console.log("\n--- Emitted release artifact contract ---");
{
	execFileSync(process.execPath, ["build-server-release.mjs"], {
		cwd: root,
		stdio: "pipe",
	});

	const emittedManifest = JSON.parse(
		readFileSync(resolve(root, "dist/release-assets/update-manifest.json"), "utf8"),
	) as UpdateManifest;
	assert(emittedManifest.latestServerVersion === SERVER_VERSION, "emitted manifest has the current server version");
	assert(emittedManifest.latestPluginVersion === manifest.version, "emitted manifest has the published plugin version");
	assert(
		emittedManifest.minCompatibleServerVersionForPlugin === SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN,
		"emitted manifest has the plugin's server floor",
	);
	assert(
		emittedManifest.minCompatiblePluginVersionForServer === SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER,
		"emitted manifest has the server's plugin floor",
	);
	assert(emittedManifest.releaseType === "compatible", "emitted manifest reflects the non-migration release type");
	assert(emittedManifest.migrationRequired === false, "emitted manifest marks the release as non-migrating");
	assert(emittedManifest.autoUpdateEligible === false, "emitted manifest disables unattended updates");
	assert(emittedManifest.upgradeOrder === "either", "emitted manifest declares either upgrade order");
	assert(
		emittedManifest.releaseNotesUrl.endsWith(`/tag/${packageJson.version}`),
		"emitted manifest release notes target the plugin release tag",
	);
	assert(
		emittedManifest.upgradeGuideUrl === "https://github.com/kavinsood/yaos#updating-your-server",
		"emitted manifest has the canonical upgrade guide URL",
	);

	const archivePath = resolve(root, "dist/release-assets/yaos-server.zip");
	const embeddedManifest = JSON.parse(
		execFileSync("unzip", ["-p", archivePath, "yaos-server-manifest.json"], {
			encoding: "utf8",
		}),
	) as {
		serverVersion: string;
		pluginVersion: string;
		migrationRequired: boolean;
		protectedFiles: string[];
		updateOwnedPaths: string[];
	};
	const archiveEntries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
		.trim()
		.split("\n");
	assert(embeddedManifest.serverVersion === SERVER_VERSION, "server archive manifest has the current server version");
	assert(embeddedManifest.pluginVersion === manifest.version, "server archive manifest has the current plugin version");
	assert(embeddedManifest.migrationRequired === false, "server archive manifest matches migration policy");
	assert(
		JSON.stringify(embeddedManifest.protectedFiles) === JSON.stringify(["wrangler.toml"]),
		"server archive protects only operator-owned wrangler.toml",
	);
	const expectedOwnedPaths = [".gitlab-ci.yml", "package.json", "package-lock.json", "scripts", "tsconfig.json", "src"];
	assert(
		JSON.stringify(embeddedManifest.updateOwnedPaths) === JSON.stringify(expectedOwnedPaths),
		"server archive declares the exact update-owned path set",
	);
	for (const ownedPath of embeddedManifest.updateOwnedPaths) {
		assert(
			archiveEntries.some((entry) => entry === ownedPath || entry.startsWith(`${ownedPath}/`)),
			`server archive contains update-owned path ${ownedPath}`,
		);
	}
	assert(archiveEntries.includes("wrangler.toml"), "server archive contains the protected wrangler.toml template");
}

console.log("\n--- Runtime compatibility decision matrix ---");
{
	const host = "https://release-matrix.test";
	const baseCapabilities: ServerCapabilities = {
		claimed: true,
		authMode: "env",
		attachments: true,
		snapshots: true,
		serverVersion: SERVER_VERSION,
		minPluginVersion: null,
		recommendedPluginVersion: SERVER_RECOMMENDED_PLUGIN_VERSION,
		minSchemaVersion: SERVER_MIN_SCHEMA_VERSION,
		maxSchemaVersion: SERVER_MAX_SCHEMA_VERSION,
		migrationRequired: false,
		updateProvider: null,
		updateRepoUrl: null,
	};
	const baseManifest: UpdateManifest = {
		latestServerVersion: SERVER_VERSION,
		latestPluginVersion: manifest.version,
		releaseType: "compatible",
		migrationRequired: false,
		autoUpdateEligible: false,
		minCompatibleServerVersionForPlugin: SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN,
		minCompatiblePluginVersionForServer: SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER,
		upgradeOrder: "either",
		releaseNotesUrl: "https://release-matrix.test/notes",
		upgradeGuideUrl: "https://release-matrix.test/guide",
	};

	function evaluateCompatibility(args: {
		pluginVersion: string;
		schemaVersion: number;
		capabilities?: Partial<ServerCapabilities>;
		updateManifest?: Partial<UpdateManifest>;
	}): { blocked: boolean; stopped: number; statusErrors: number } {
		let stopped = 0;
		let statusErrors = 0;
		const service = new CapabilityUpdateService({
			getSettings: () => ({ host, token: "" } as never),
			pluginVersion: args.pluginVersion,
			schemaVersion: args.schemaVersion,
			trace: () => {},
			log: () => {},
			persistPluginState: async () => {},
			hasSyncRuntime: () => true,
			isSyncConnectedAndProviderSynced: () => true,
			refreshAttachmentSyncRuntime: async () => {},
			triggerDailySnapshot: () => {},
			stopSyncRuntimeForCompatibility: () => { stopped++; },
			setStatusError: () => { statusErrors++; },
			scheduleTraceStateSnapshot: () => {},
			updateSettings: async () => {},
		});
		service.hydratePersistedCaches(
			{ host, capabilities: { ...baseCapabilities, ...args.capabilities } },
			{ fetchedAt: Date.now(), manifest: { ...baseManifest, ...args.updateManifest } },
		);
		return {
			blocked: service.enforceCompatibilityGuard("release-matrix"),
			stopped,
			statusErrors,
		};
	}

	const currentPair = evaluateCompatibility({ pluginVersion: manifest.version, schemaVersion: SCHEMA_VERSION });
	assert(!currentPair.blocked && currentPair.stopped === 0 && currentPair.statusErrors === 0, "current plugin/server pair remains sync-compatible at runtime");

	const stagedPair = evaluateCompatibility({
		pluginVersion: "1.6.0",
		schemaVersion: SCHEMA_VERSION,
		capabilities: { serverVersion: "0.1.9" },
	});
	assert(!stagedPair.blocked, "older-than-latest plugin is not blocked by the latest release's server floor");

	const blockedServerPair = evaluateCompatibility({
		pluginVersion: manifest.version,
		schemaVersion: SCHEMA_VERSION,
		capabilities: { serverVersion: "0.1.9" },
	});
	assert(
		blockedServerPair.blocked && blockedServerPair.stopped === 1 && blockedServerPair.statusErrors === 1,
		"latest plugin blocks and tears down sync against a server below its declared floor",
	);

	const blockedPluginPair = evaluateCompatibility({
		pluginVersion: "1.3.2",
		schemaVersion: SCHEMA_VERSION,
		capabilities: { minPluginVersion: "1.3.3" },
	});
	assert(
		blockedPluginPair.blocked && blockedPluginPair.stopped === 1 && blockedPluginPair.statusErrors === 1,
		"live server plugin floor blocks an outdated plugin before sync",
	);

	const blockedBelowPin = evaluateCompatibility({
		pluginVersion: manifest.version,
		schemaVersion: SERVER_MIN_SCHEMA_VERSION - 1,
	});
	assert(blockedBelowPin.blocked, "local schema one below the pinned server schema is blocked at runtime");

	const blockedAbovePin = evaluateCompatibility({
		pluginVersion: manifest.version,
		schemaVersion: SERVER_MAX_SCHEMA_VERSION + 1,
	});
	assert(blockedAbovePin.blocked, "local schema one above the pinned server schema is blocked at runtime");

	const manifestPluginFloorOnly = evaluateCompatibility({
		pluginVersion: "1.0.0",
		schemaVersion: SCHEMA_VERSION,
		updateManifest: { minCompatiblePluginVersionForServer: "99.0.0" },
	});
	assert(
		!manifestPluginFloorOnly.blocked,
		"server-side plugin floor comes from live capabilities, not unused update-manifest metadata",
	);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
