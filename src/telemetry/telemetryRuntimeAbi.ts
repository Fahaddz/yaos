/**
 * ABI contract embedded in both separately shipped bundles.
 *
 * Increment this value whenever the telemetry installer export or the
 * TelemetryRuntimeHost/TelemetryRuntimeHandle contract changes incompatibly.
 * The loader checks the value before invoking telemetry.js, so a stale bundle
 * fails closed without affecting sync startup.
 */
export const TELEMETRY_RUNTIME_ABI_VERSION = 3;
