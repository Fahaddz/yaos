export const SERVER_VERSION = "0.3.0";

// Compatibility metadata is intentionally explicit so the plugin can reason
// about safe upgrade paths before we add richer release-manifest logic.
export const SERVER_MIN_PLUGIN_VERSION: string | null = null;
export const SERVER_RECOMMENDED_PLUGIN_VERSION = "1.5.0";
export const SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN = "0.2.0";
export const SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER = "1.3.3";
// The server admits exactly one schema version — the same value the plugin
// writes (`SCHEMA_VERSION` in src/sync/schema.ts). MIN and MAX are therefore
// equal by construction; `scripts/guard-schema-version.mjs` enforces that.
// The pair survives as two symbols because `/api/capabilities` publishes both
// (see server/src/routes/auth.ts): the plugin compares its local schema against
// the envelope to render an actionable "your server is too old" / "your plugin
// is too old" message instead of a bare WebSocket failure.
export const SERVER_MIN_SCHEMA_VERSION = 3;
export const SERVER_MAX_SCHEMA_VERSION = 3;
export const SERVER_MIGRATION_REQUIRED = false;
