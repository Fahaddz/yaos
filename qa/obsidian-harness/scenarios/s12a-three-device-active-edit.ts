/**
 * s12a-three-device-active-edit — manual real-device validation
 *
 * Purpose: prove that one genuine edit made in Obsidian's YAOS-backed Markdown
 * editor on Linux converges to real foreground iPad and Android clients.
 *
 * Manual-only: do not add CDP, browser, simulator, shell, adapter-write, or
 * app.vault.modify automation. The QA harness plugin supplies command-palette
 * controls for scenario annotations and fresh read-only witness observations.
 *
 * Operator sequence:
 *  1. On Linux (Device A), real iPad foreground (Device B), and real Android
 *     foreground (Device C), install the QA harness, enable qaDebugMode, set
 *     the same qaTraceSecret, and keep every device foreground for the run.
 *  2. Set the same scenarioRunId and this scenarioId using
 *     "YAOS QA: Set scenario run ID" on every device.
 *  3. Start "Start QA flight trace" in qa-safe mode on every device.
 *  4. Open targetPath on every device with baselineContent already present.
 *     Advance all devices to step 1 (baseline-quorum), then invoke
 *     "Force fresh QA witness for current file" on every device and wait for
 *     baseline witnesses.
 *  5. On Device A only, edit the open note in Obsidian's Markdown editor so it
 *     contains postEditMarker. Do not use a shell, external editor, direct disk
 *     write, adapter write, app.vault.modify, or any test-helper write.
 *  6. On Device A, advance to step 2 (edit-applied-on-a), force a fresh witness,
 *     and wait for a settled hash that differs from the baseline hash.
 *  7. Once Device B visibly has the edit, advance it to step 3 (settled-on-b),
 *     force a fresh witness, and wait for the Device A post-edit hash. Repeat on
 *     Device C at step 4 (settled-on-c). A non-foreground state on iPad or
 *     Android invalidates the pass run.
 *  8. Advance all devices to step 5 (ready-to-export), export each safe witness
 *     bundle while tracing is still active, then stop traces. Do not model export
 *     as a trace step after tracing has stopped.
 *  9. Analyze the untouched bundles into the canonical pass or fail directory.
 *
 * This file configures the run. It does not claim a pass; a real-device run must
 * still create qa-runs/s12a-three-device-active-edit-pass/ evidence.
 */

export const SCENARIO_ID = "s12a-three-device-active-edit";
export const SCENARIO_VERSION = 1;

export const S12A_THREE_DEVICE_ACTIVE_EDIT = {
	targetPath: "QA-scratch/s12a-active-edit-witness.md",
	producingDevice: "device-a",
	consumingDevices: ["device-b", "device-c"],
	baselineContent: "S12A-AE-BASELINE-CONTENT-MUST-BE-NONEMPTY\n",
	postEditMarker: "S12A-AE-EDITED-FROM-A",
	baselineStep: 1,
	producerPostEditStep: 2,
	consumerBSettledStep: 3,
	consumerCSettledStep: 4,
	readyToExportStep: 5,
	forbiddenDivergenceReasons: [
		"stale_hash_after_newer_witness",
		"recovery_emitted_old_hash",
	],
	bundleRoles: {
		"device-a": "desktop",
		"device-b": "ios",
		"device-c": "android",
	},
} as const;
