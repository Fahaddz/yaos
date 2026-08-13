import type { TAbstractFile, Workspace } from "obsidian";

/**
 * Obsidian runtime members that the shipped API surface (obsidian.d.ts) does
 * not declare.
 *
 * WHY THIS FILE EXISTS: the product legitimately depends on members the public
 * typings omit. Every dependency used to be expressed as
 * `x as unknown as { ... }` at the call site — a per-site lie repeated 15 times
 * across editorBinding.ts, main.ts, blobSync.ts and diskMirror.ts, with two
 * copies already disagreeing about whether the member was optional. Declaring
 * them once here states the assumption in one place, keeps the property
 * optional where the runtime does not guarantee it, and lets tsc check the
 * reads.
 */
declare module "obsidian" {
	interface WorkspaceLeaf {
		/**
		 * Obsidian's per-leaf identity, used for workspace serialisation. It is
		 * present on every real leaf but absent on hand-built leaf objects, so
		 * it is declared optional: callers must supply a fallback identity
		 * (they all fall back to the file path).
		 */
		readonly id?: string;
		/**
		 * Back-reference to the workspace that owns the leaf. Used only to ask
		 * "is this leaf the active one?" from code that holds a leaf but no App
		 * handle. Optional for the same reason as `id`.
		 */
		readonly workspace?: Workspace;
	}
}
