import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

function sliceBetween(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	return source.slice(start, end);
}

/** Source with comments removed, so call-site counts ignore prose. */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
}

const workspaceSource = readFileSync(new URL("../src/runtime/editorWorkspaceOrchestrator.ts", import.meta.url), "utf8");
const bindingSource = readFileSync(new URL("../src/sync/editorBinding.ts", import.meta.url), "utf8");

console.log("\n--- Test 1: validateOpenBindings uses repair-only flow ---");
{
	const section = sliceBetween(
		workspaceSource,
		"validateOpenBindings(reason: string): void {",
		"auditBindings(reason: string): number {",
	);
	assert(section !== null, "validateOpenBindings section found");
	assert(section?.includes("editorBindings.repair("), "validateOpenBindings calls repair");
	assert(!section?.includes("editorBindings.heal("), "validateOpenBindings does not call heal");
}

console.log("\n--- Test 2: bind unhealthy path uses repair, not heal ---");
{
	const section = sliceBetween(
		bindingSource,
		"bind(view: MarkdownView, deviceName: string): void {",
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	assert(section !== null, "bind section found");
	assert(section?.includes("if (this.repair(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path calls repair");
	assert(!section?.includes("if (this.heal(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path does not call heal");
}

console.log("\n--- Test 3: maybeHealBinding uses repair/rebind and traces repair-only ---");
{
	const section = sliceBetween(
		bindingSource,
		"private maybeHealBinding(",
		"private scheduleCmResolveRetry(",
	);
	assert(section !== null, "maybeHealBinding section found");
	assert(section?.includes("const repaired = this.repair("), "maybeHealBinding calls repair");
	assert(!section?.includes("const healed = this.heal("), "maybeHealBinding does not call heal");
	assert(section?.includes('? "repair-only"'), "health-restored action reports repair-only");
}

console.log("\n--- Test 4: editor-health-heal origin remains manual-only ---");
{
	const healSection = sliceBetween(
		bindingSource,
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
	);
	assert(healSection !== null, "heal section found");
	// After the origin-constants refactor the call site uses ORIGIN_EDITOR_HEALTH_HEAL
	// (imported from src/sync/origins.ts) instead of the raw string. Check for the
	// constant name rather than the literal.
	assert(
		healSection?.includes("ORIGIN_EDITOR_HEALTH_HEAL"),
		"editor-health-heal origin used via named constant in heal() implementation",
	);
	// Strip the heal section then check that applyDiffToYText is NOT called
	// with ORIGIN_EDITOR_HEALTH_HEAL outside it. The import declaration
	// is allowed to remain (it's not a call site). Use [^\n)]* to stay
	// on the same line and avoid spurious cross-line matches.
	const strippedSource = bindingSource.replace(healSection ?? "", "");
	assert(
		!strippedSource.match(/applyDiffToYText[^\n)]*ORIGIN_EDITOR_HEALTH_HEAL/),
		"ORIGIN_EDITOR_HEALTH_HEAL not passed to applyDiffToYText outside heal()",
	);
}

console.log("\n--- Test 5: CM resolution prefers editorInfoField and fails closed ---");
{
	const section = sliceBetween(
		bindingSource,
		"private getCmView(view: MarkdownView): EditorView | null {",
		"private warnCmDegraded(): void {",
	);
	assert(section !== null, "getCmView section found");
	assert(
		bindingSource.includes("cm.state.field(editorInfoField, false)"),
		"editor ownership is read from Obsidian's public editorInfoField",
	);
	const infoIndex = section?.indexOf("if (infoMatches.length === 1)") ?? -1;
	const domIndex = section?.indexOf("if (matches.length === 0)") ?? -1;
	assert(
		infoIndex >= 0 && domIndex >= 0 && infoIndex < domIndex,
		"editorInfoField ownership is consulted before DOM containment",
	);
	const ambiguousIndex = section?.indexOf('"cm-resolution-ambiguous"') ?? -1;
	assert(
		ambiguousIndex >= 0
		&& (section?.indexOf("return null;", ambiguousIndex) ?? -1) > ambiguousIndex,
		"ambiguous resolution fails closed instead of binding a guessed editor",
	);
	// knownCmViews is populated by our ViewPlugin, whose construction lags the
	// workspace event that triggers bind(). Measured on a 121-note vault:
	// 32 resolution failures without this fallback, 0 with it.
	const zeroMatchIndex = section?.indexOf("if (matches.length === 0)") ?? -1;
	const fromDomIndex = section?.indexOf("EditorView.findFromDOM(container)") ?? -1;
	const giveUpIndex = zeroMatchIndex >= 0
		? (section?.indexOf("return null;", zeroMatchIndex) ?? -1)
		: -1;
	assert(
		fromDomIndex > zeroMatchIndex && fromDomIndex < giveUpIndex,
		"zero-match falls back to CodeMirror findFromDOM before giving up",
	);
}

console.log("\n--- Test 6: CM resolve retries outlast layout churn and stay diagnosable ---");
{
	const delayMs = Number(bindingSource.match(/CM_RESOLVE_RETRY_DELAY_MS = (\d+)/)?.[1]);
	const maxRetries = Number(bindingSource.match(/CM_RESOLVE_MAX_RETRIES = (\d+)/)?.[1]);
	const settleWindowMs = Number(
		bindingSource.match(/FAST_SWITCH_BINDING_SETTLE_WINDOW_MS = (\d+)/)?.[1],
	);
	assert(
		Number.isFinite(delayMs) && Number.isFinite(maxRetries) && Number.isFinite(settleWindowMs),
		"CM resolve retry constants are readable",
	);
	// Delays are linear in attempt count, so the budget is the triangular sum.
	const budgetMs = (delayMs * maxRetries * (maxRetries + 1)) / 2;
	assert(
		budgetMs > settleWindowMs,
		`CM resolve retry budget (${budgetMs}ms) outlasts the fast-switch settle window (${settleWindowMs}ms)`,
	);
	const retrySection = sliceBetween(
		bindingSource,
		"private scheduleCmResolveRetry(",
		"private clearCmResolveRetry(",
	);
	assert(
		retrySection?.includes("failure: this.lastCmResolveFailure"),
		"degraded trace reports why resolution failed",
	);
}

console.log("\n--- Test 7: closed leaves release their bindings ---");
{
	const section = sliceBetween(
		bindingSource,
		"pruneOrphanedBindings(liveLeafKeys: ReadonlySet<string>, source: string): number {",
		"private createUndoManager(",
	);
	assert(section !== null, "pruneOrphanedBindings section found");
	// Two independent signals must agree. Leaf-absence alone would unbind a
	// live editor if a workspace mutation transiently hid its leaf.
	assert(
		section?.includes("if (liveLeafKeys.has(leafId)) continue;"),
		"a binding whose leaf is still open is never pruned",
	);
	assert(
		section?.includes("if (this.knownCmViews.has(binding.cm)) {"),
		"a binding whose EditorView is still registered is never pruned",
	);
	// Teardown must match unbindByPath or the prune trades one leak for another.
	assert(
		section?.includes("binding.undoManager.destroy();"),
		"pruning destroys the UndoManager",
	);
	assert(
		section?.includes("this.bindings.delete(leafId);")
		&& section?.includes("this.cmToLeafId.delete(binding.cm);"),
		"pruning releases the binding and its CM mapping",
	);

	const orchestratorSource = readFileSync(
		new URL("../src/runtime/editorWorkspaceOrchestrator.ts", import.meta.url),
		"utf8",
	);
	const layout = sliceBetween(
		orchestratorSource,
		"onLayoutChange(): void {",
		"pruneOrphanedBindings(reason: string): number {",
	);
	const pruneCall = layout?.indexOf("this.pruneOrphanedBindings(") ?? -1;
	const auditCall = layout?.indexOf("this.auditBindings(") ?? -1;
	assert(
		pruneCall >= 0 && auditCall >= 0 && pruneCall < auditCall,
		"layout-change prunes dead bindings before auditing the rest",
	);
	// Keys must be derived exactly as bind() does, or path-keyed bindings
	// would never match a live entry and would be pruned while in use.
	assert(
		orchestratorSource.includes('"id" in leaf && typeof leaf.id === "string"')
		&& orchestratorSource.includes("view.file?.path"),
		"live leaf keys use the same leaf-id-then-path derivation as bind()",
	);
}

console.log("\n--- Test 8: Yjs doc observers do not accumulate per bind ---");
{
	// Y.UndoManager's constructor adds a `destroy` hook that destroy() never
	// removes, and YSyncConfig builds a second manager it never uses. Left
	// alone each bind leaked one observer of each kind, permanently.
	const bindingCode = stripComments(bindingSource);
	const undoManagerConstructions =
		bindingCode.match(/new Y\.UndoManager\(/g)?.length ?? 0;
	assert(
		undoManagerConstructions === 1,
		"UndoManagers are only constructed inside createUndoManager",
	);
	const yCollabCalls = bindingCode.match(/yCollab\(/g)?.length ?? 0;
	assert(
		yCollabCalls === 1,
		"yCollab is only invoked inside buildCollabExtension",
	);

	const builder = sliceBetween(
		bindingSource,
		"private buildCollabExtension(",
		"private releaseAddedDocObservers(",
	);
	assert(builder !== null, "buildCollabExtension section found");
	assert(
		builder?.includes('this.releaseAddedDocObservers(doc, "destroy", destroyBefore)')
		&& builder?.includes('this.releaseAddedDocObservers(doc, "afterTransaction", transactionBefore)'),
		"the stray YSyncConfig UndoManager's observers are both released",
	);

	const factory = sliceBetween(
		bindingSource,
		"private createUndoManager(",
		"* Build the collab extension",
	);
	assert(
		factory?.includes('this.releaseAddedDocObservers(doc, "destroy", before)')
		&& !factory?.includes('"afterTransaction"'),
		"our own UndoManager keeps its afterTransaction subscription so undo works",
	);
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
