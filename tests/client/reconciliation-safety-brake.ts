import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { updateIndex, type DiskIndex } from "../../src/sync/diskIndex";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
} from "../../src/sync/origins";
import { suite } from "../harness.ts";

const s = suite("reconciliation-safety-brake");

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

type BoundMarkdownView = MarkdownView & { file: TFile; editor: { getValue(): string } };

// `new MarkdownView()` requires a WorkspaceLeaf that this fixture has no way to
// build, and the recovery paths under test only read `view.file` and
// `view.editor.getValue()` — so the view is a prototype instance (instanceof
// still holds for the runtime mock) carrying exactly those two members.
function makeBoundView(file: TFile, getValue: () => string): BoundMarkdownView {
	return Object.assign(Object.create(MarkdownView.prototype), {
		file,
		editor: { getValue },
	});
}

s.section("Test 1: updateIndex removes blocked paths from the index");
{
	const index: DiskIndex = {
		"blocked.md": { mtime: 1, size: 1 },
		"clean.md": { mtime: 1, size: 1 },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		["blocked.md", { mtime: 2, size: 2 }],
		["clean.md", { mtime: 2, size: 2 }],
		["new.md", { mtime: 2, size: 2 }],
	]);

	const next = updateIndex(index, stats, { excludePaths: ["blocked.md"] });
	s.check(!("blocked.md" in next), "blocked path is unindexed, not preserved");
	s.check(next["clean.md"]?.mtime === 2, "unblocked path advances mtime");
	s.check(next["new.md"]?.mtime === 2, "new unblocked path is indexed");
}

s.section("Test 2: same-stat excluded paths are still unindexed");
{
	const index: DiskIndex = {
		"blocked.md": { mtime: 1, size: 1 },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		["blocked.md", { mtime: 1, size: 1 }],
	]);

	const next = updateIndex(index, stats, { excludePaths: ["blocked.md"] });
	s.check(!("blocked.md" in next), "same-stat blocked path is removed from index");
}

s.section("Test 3: reconciliation safety brake leaves blocked overwrites unindexed");
{
	const paths = Array.from({ length: 30 }, (_, i) => `note-${i}.md`);
	const files = paths.map(makeTFile);
	let diskIndex: DiskIndex = {};
	for (const path of paths) {
		diskIndex[path] = { mtime: 1, size: 1 };
	}

	const stats = new Map<string, { mtime: number; size: number }>();
	for (const path of paths) {
		stats.set(path, { mtime: 2, size: 2 });
	}

	const reads: string[] = [];
	const flushed: string[] = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let saveDiskIndexCalls = 0;

	const app = {
		vault: {
			getMarkdownFiles: () => files,
			read: async (file: TFile & { path: string }) => {
				reads.push(file.path);
				return `local ${file.path}`;
			},
			adapter: {
				stat: async (path: string) => stats.get(path) ?? null,
			},
			getAbstractFileByPath: () => null,
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const vaultSync = {
		getTextForPath: () => ({ toJSON: () => "remote content" }),
		getActiveMarkdownPaths: () => paths,
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: paths,
			seededToCrdt: [],
			untracked: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({ flushWrite: async (path: string) => { flushed.push(path); } }) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => { saveDiskIndexCalls++; },
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	s.check(reads.length === 30, "authoritative reconcile reads all files");
	s.check(flushed.length === 0, "safety brake blocks destructive update flushes");
	s.check(saveDiskIndexCalls === 1, "disk index save is still attempted");
	for (const path of paths) {
		s.check(!(path in diskIndex), `blocked path is unindexed: ${path}`);
	}
	s.check(
		traces.some((event) =>
			event.source === "reconcile" &&
			event.msg === "reconcile-disk-index-advance-blocked" &&
			event.details?.blockedCount === 30
		),
		"blocked disk-index advancement is traced",
	);
}

s.section("Test 4: second reconcile reads blocked paths again");
{
	const paths = Array.from({ length: 30 }, (_, i) => `again-${i}.md`);
	const files = paths.map(makeTFile);
	let diskIndex: DiskIndex = {};
	for (const path of paths) {
		diskIndex[path] = { mtime: 1, size: 1 };
	}

	const stats = new Map<string, { mtime: number; size: number }>();
	for (const path of paths) {
		stats.set(path, { mtime: 1, size: 1 });
	}

	const reads: string[] = [];
	const flushed: string[] = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const app = {
		vault: {
			getMarkdownFiles: () => files,
			read: async (file: TFile & { path: string }) => {
				reads.push(file.path);
				return `local ${file.path}`;
			},
			adapter: {
				stat: async (path: string) => stats.get(path) ?? null,
			},
			getAbstractFileByPath: () => null,
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const vaultSync = {
		getTextForPath: () => ({ toJSON: () => "remote content" }),
		getActiveMarkdownPaths: () => paths,
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: paths,
			seededToCrdt: [],
			untracked: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({ flushWrite: async (path: string) => { flushed.push(path); } }) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");
	const firstReadCount = reads.length;
	(controller as any).lastReconcileTime = 0;
	await controller.runReconciliation("authoritative");

	s.check(firstReadCount === 30, "first reconcile reads all blocked paths");
	s.check(reads.length === 60, "second reconcile reads blocked paths again");
	s.check(flushed.length === 0, "safety brake blocks destructive flushes on both passes");
	s.check(
		traces.filter((event) => event.msg === "reconcile-disk-index-advance-blocked").length === 2,
		"blocked divergence is traced on both reconciles",
	);
}

s.section("Test 5: bound recovery force-replaces when CRDT changes after authority decision");
{
	const path = "bound-stale-base.md";
	const diskContent = "abcY";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "abcX");

	const file = makeTFile(path);
	const view = makeBoundView(file, () => diskContent);

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	const transactionOrigins: unknown[] = [];
	doc.on("afterTransaction", (txn) => {
		transactionOrigins.push(txn.origin);
	});

	let mutatedDuringGuard = false;
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => diskContent,
			adapter: {
				stat: async () => ({ mtime: 10, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => true,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => {
			if (!mutatedDuringGuard) {
				mutatedDuringGuard = true;
				ytext.delete(0, ytext.length);
				ytext.insert(0, "abcZ");
			}
			return false;
		},
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await (controller as any).syncFileFromDisk(file, "modify");

	const forceTrace = traces.find((event) => event.msg === "recovery-force-replace-applied");
	const postconditionTrace = traces.find((event) => event.msg === "recovery-postcondition-observed");
	s.check(ytext.toString() === diskContent, "controller recovery lands exact disk content");
	s.check(!!forceTrace, "controller recovery traces force replace fallback");
	s.check(forceTrace?.details?.diffSkippedDueToStaleBase === true, "force replace skipped stale-base diff");
	s.check(postconditionTrace?.details?.enforced === true, "controller recovery postcondition is enforced");
	s.check(
		transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"force replace uses a known local repair origin",
	);
	doc.destroy();
}

s.section("Test 6: bound ambiguous divergence creates a conflict artifact");
{
	const path = "ambiguous.md";
	const diskContent = "disk version";
	const crdtContent = "crdt version";
	const editorContent = "editor version";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = makeBoundView(file, () => editorContent);

	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => diskContent,
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			getAbstractFileByPath: (candidate: string) => createdFiles.has(candidate) ? ({ path: candidate }) : null,
			adapter: {
				stat: async () => ({ mtime: 11, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await (controller as any).syncFileFromDisk(file, "modify");

	const createdPath = Array.from(createdFiles.keys()).find((candidate) =>
		candidate.startsWith("ambiguous (YAOS conflict - crdt from Test Device ") &&
		candidate.endsWith(".md")
	);
	const diskCreatedPath = Array.from(createdFiles.keys()).find((candidate) =>
		candidate.startsWith("ambiguous (YAOS conflict - disk from Test Device ") &&
		candidate.endsWith(".md")
	);
	const neededTrace = traces.find((event) => event.msg === "conflict-artifact-needed");
	s.check(ytext.toString() === editorContent, "ambiguous path converges CRDT to visible editor content after artifact creation");
	s.check(!!createdPath, "ambiguous divergence creates a CRDT conflict note");
	s.check(createdPath ? createdFiles.get(createdPath) === crdtContent : false, "conflict note preserves competing CRDT content");
	s.check(!!diskCreatedPath, "true three-way divergence creates a disk conflict note");
	s.check(diskCreatedPath ? createdFiles.get(diskCreatedPath) === diskContent : false, "disk conflict note preserves disk content");
	s.check(neededTrace?.details?.conflictArtifactCreated === true, "conflict-needed trace reports artifact creation");
	s.check(neededTrace?.details?.convergenceApplied === true, "conflict-needed trace reports convergence applied");
	s.check(
		traces.some((event) => event.msg === "conflict-artifact-created"),
		"conflict artifact creation is traced",
	);
	doc.destroy();
}

s.section("Test 7: repeated identical recovery fingerprint is quarantined");
{
	const path = "loop.md";
	const diskContent = "disk authority";
	const crdtContent = "stale crdt";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = makeBoundView(file, () => diskContent);

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => diskContent,
			adapter: {
				stat: async () => ({ mtime: 12, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => true,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	for (let i = 0; i < 3; i++) {
		ytext.delete(0, ytext.length);
		ytext.insert(0, crdtContent);
		(controller as any).boundRecoveryLocks.clear();
		await (controller as any).syncFileFromDisk(file, "modify");
	}

	s.check(
		traces.some((event) =>
			event.msg === "recovery-quarantined" &&
			event.details?.repeatCount === 3
		),
		"third identical recovery fingerprint is quarantined",
	);
	s.check(ytext.toString() === crdtContent, "quarantined recovery does not keep hammering the file");
	// Verify recovery fingerprint map does not store raw content
	const fingerprints: Map<string, { fingerprint: string; count: number; lastAt: number }> =
		(controller as any).recoveryFingerprints;
	const entry = fingerprints.get(path);
	s.check(!!entry, "fingerprint entry exists for quarantined path");
	s.check(!entry!.fingerprint.includes(diskContent), "fingerprint does not contain raw disk content");
	s.check(!entry!.fingerprint.includes(crdtContent), "fingerprint does not contain raw CRDT content");
	s.check(entry!.fingerprint.includes(":"), "fingerprint uses hash:length format");
	doc.destroy();
}

// ── Test 8: successful recovery clears quarantine fingerprint ──────────────

s.section("Test 8: successful recovery clears quarantine fingerprint");
{
	const path = "recover-then-clear.md";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "stale");

	const file = makeTFile(path);
	const view = makeBoundView(file, () => "disk version A");

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => "disk version A",
			adapter: {
				stat: async () => ({ mtime: 13, size: 14 }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => true,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// First recovery — should succeed
	await (controller as any).syncFileFromDisk(file, "modify");
	s.check(ytext.toString() === "disk version A", "first recovery succeeds");

	// A different fingerprint (different content) should reset the count,
	// so future legitimate recovery for this path is not blocked.
	const fingerprints: Map<string, any> = (controller as any).recoveryFingerprints;
	const entry = fingerprints.get(path);
	// The path has a fingerprint entry from the recovery attempt
	s.check(entry?.count === 1, "recovery attempt increments count to 1");

	// Now change CRDT to something new and recover again — different fingerprint
	ytext.delete(0, ytext.length);
	ytext.insert(0, "new-stale");
	(controller as any).boundRecoveryLocks.clear();
	await (controller as any).syncFileFromDisk(file, "modify");
	s.check(ytext.toString() === "disk version A", "different-fingerprint recovery still succeeds");

	const entry2 = fingerprints.get(path);
	s.check(entry2?.count === 1, "different fingerprint resets count to 1 (not accumulated)");

	doc.destroy();
}

s.section("Test 9: convergence failure does not create infinite conflict artifacts");
{
	const path = "convergence-fails.md";
	const diskContent = "disk version";
	const crdtContent = "crdt version";
	const editorContent = "editor version";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = makeBoundView(file, () => editorContent);

	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	// Simulate convergence failure: getTextForPath returns null on the
	// second call (the convergence re-lookup after artifact creation).
	let getTextForPathCallCount = 0;
	const app = {
		vault: {
			read: async () => diskContent,
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			getAbstractFileByPath: (candidate: string) => createdFiles.has(candidate) ? ({ path: candidate }) : null,
			adapter: {
				stat: async () => ({ mtime: 14, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => {
			getTextForPathCallCount++;
			// Return ytext for the first call (syncFileFromDisk's initial check)
			// but null for the second call (convergence re-lookup).
			// On second syncFileFromDisk invocation, same pattern.
			if (getTextForPathCallCount % 2 === 1) return ytext;
			return null;
		},
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// First call: creates artifact, convergence fails because getTextForPath returns null
	await (controller as any).syncFileFromDisk(file, "modify");
	s.check(createdFiles.size === 2, "first pass creates CRDT and disk conflict artifacts");

	const firstTraces = traces.filter((t) => t.msg === "conflict-artifact-needed");
	s.check(firstTraces.length === 1, "first pass traces conflict-artifact-needed");
	s.check(firstTraces[0]?.details?.conflictArtifactCreated === true, "first pass artifact was created");
	// convergenceApplied is false because getTextForPath returned null for the convergence call
	s.check(firstTraces[0]?.details?.convergenceApplied === false, "first pass convergence was not applied");

	// Second call with same divergence: dedupe prevents second artifact
	await (controller as any).syncFileFromDisk(file, "modify");
	s.check(createdFiles.size === 2, "second pass does NOT create more conflict artifacts (dedupe)");

	const secondTraces = traces.filter((t) => t.msg === "conflict-artifact-needed");
	s.check(secondTraces.length === 2, "second pass still traces conflict-artifact-needed");
	s.check(secondTraces[1]?.details?.conflictSkippedDedupe === true, "second pass reports dedupe skip");

	doc.destroy();
}

s.section("Test 10: second reconcile after successful convergence does not create duplicate artifact");
{
	const path = "already-converged.md";
	const diskContent = "disk authority";
	const crdtContent = "crdt version B";
	const editorContent = "editor version B";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = makeBoundView(file, () => editorContent);

	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => diskContent,
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			getAbstractFileByPath: (candidate: string) => createdFiles.has(candidate) ? ({ path: candidate }) : null,
			adapter: {
				stat: async () => ({ mtime: 15, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// First call: artifact created, convergence succeeds
	await (controller as any).syncFileFromDisk(file, "modify");
	s.check(createdFiles.size === 2, "first pass creates CRDT and disk conflict artifacts");
	s.check(ytext.toString() === editorContent, "first pass converges CRDT to editor");

	// Second call: CRDT already matches disk, so it exits early via the
	// crdtContent === content check in syncFileFromDisk. No second artifact.
	// Reset CRDT to create ambiguity again and verify dedupe is cleared after convergence
	ytext.delete(0, ytext.length);
	ytext.insert(0, "new-crdt-version");
	await (controller as any).syncFileFromDisk(file, "modify");

	// This is a genuinely new divergence (different CRDT content), so a
	// new artifact should be created.
	s.check(createdFiles.size === 4, "genuinely new divergence creates new CRDT and disk conflict artifacts");

	doc.destroy();
}

s.section("Test 11: artifact creation failure does NOT trigger convergence");
{
	const path = "artifact-fails.md";
	const diskContent = "disk version";
	const crdtContent = "crdt version";
	const editorContent = "editor version";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = makeBoundView(file, () => editorContent);

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => diskContent,
			// vault.create always throws — simulating disk-full / permissions error
			create: async () => { throw new Error("disk full"); },
			getAbstractFileByPath: () => null,
			adapter: {
				stat: async () => ({ mtime: 16, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await (controller as any).syncFileFromDisk(file, "modify");

	// CRDT must be UNTOUCHED — still contains original content
	s.check(ytext.toString() === crdtContent, "CRDT is untouched after artifact creation failure");

	const conflictTraces = traces.filter((t) => t.msg === "conflict-artifact-needed");
	s.check(conflictTraces.length === 1, "traces conflict-artifact-needed");
	s.check(conflictTraces[0]?.details?.conflictArtifactCreated === false, "conflictArtifactCreated is false");
	s.check(conflictTraces[0]?.details?.convergenceApplied === false, "convergenceApplied is false");
	s.check(conflictTraces[0]?.details?.error === "disk full", "error message is captured");

	doc.destroy();
}

s.section("Test 12: recovery fingerprint TTL prevents stale accumulation");
{
	const path = "ttl-test.md";
	const controller = new ReconciliationController({
		app: { vault: {}, workspace: {} } as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => null,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	const shouldQuarantine = (controller as any).shouldQuarantineRepeatedRecovery.bind(controller);

	// Accumulate to count 2 (just below threshold of 3)
	s.check(shouldQuarantine(path, "r", "a", "b") === false, "count 1: no quarantine");
	s.check(shouldQuarantine(path, "r", "a", "b") === false, "count 2: no quarantine");

	// Manually set lastAt far in the past to simulate TTL expiry
	const fp = (controller as any).recoveryFingerprints.get(path);
	fp.lastAt = Date.now() - 15 * 60_000; // 15 minutes ago

	// Same fingerprint but beyond TTL — count resets to 1
	s.check(shouldQuarantine(path, "r", "a", "b") === false, "count reset to 1 after TTL expiry");
	// One more should still be fine (count 2)
	s.check(shouldQuarantine(path, "r", "a", "b") === false, "count 2 after reset: no quarantine");
	// Third within TTL — now quarantines
	s.check(shouldQuarantine(path, "r", "a", "b") === true, "count 3 after reset: quarantined");
}
await s.done();
