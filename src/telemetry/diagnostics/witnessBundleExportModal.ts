import { App, Modal, Notice } from "obsidian";
import { copyWitnessBundleToClipboard } from "./witnessBundleFormat";

/**
 * Selectable fallback when the platform clipboard is unavailable. The bundle
 * remains in the UI process only; this modal never writes to the vault.
 */
export class WitnessBundleExportModal extends Modal {
	constructor(app: App, private readonly bundle: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-witness-bundle-modal");
		contentEl.createEl("h3", { text: "Safe witness bundle" });
		contentEl.createEl("p", {
			text: "Clipboard access was unavailable. Select or copy this safe diagnostic bundle to share it with the QA analyzer. It is not written to your vault.",
			cls: "yaos-modal-copy",
		});

		const textArea = contentEl.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		textArea.value = this.bundle;
		textArea.readOnly = true;
		textArea.rows = 14;

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy witness bundle" }).addEventListener("click", () => {
			void copyWitnessBundleToClipboard(this.bundle).then((copied) => {
				if (copied) {
					new Notice("Safe witness bundle copied to clipboard.", 4000);
				} else {
					new Notice("Clipboard access is unavailable. Select and copy the bundle manually.", 6000);
				}
			});
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
