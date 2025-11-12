import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';

interface BookmarkEntry {
	file: string;
	line: number;
	ch: number;
}

interface BookmarkSettings {
	bookmarks: Record<string, BookmarkEntry>;
}

const DEFAULT_SETTINGS: BookmarkSettings = {
	bookmarks: {},
};

export default class BookmarkLineWithHotkeysPlugin extends Plugin {
	settings: BookmarkSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.registerCommands();
	}

	onunload() {
		// Nothing to clean up beyond registered commands
	}

	private registerCommands() {
		for (let slot = 1; slot <= 9; slot++) {
			const slotKey = slot.toString();

			this.addCommand({
				id: `set-bookmark-${slot}`,
				name: `Set bookmark ${slot}`,
				hotkeys: [{ modifiers: ['Mod', 'Shift'], key: slotKey }],
				editorCallback: (editor: Editor, view: MarkdownView) => {
					if (!view?.file) {
						new Notice('No active file to bookmark.');
						return;
					}

					void this.setBookmark(slotKey, editor, view);
				},
			});

			this.addCommand({
				id: `jump-to-bookmark-${slot}`,
				name: `Jump to bookmark ${slot}`,
				hotkeys: [{ modifiers: ['Mod', 'Alt'], key: slotKey }],
				callback: () => {
					void this.goToBookmark(slotKey);
				},
			});
		}
	}

	private async setBookmark(slot: string, editor: Editor, view: MarkdownView) {
		const file = view.file;
		if (!file) {
			new Notice('Unable to determine the current file.');
			return;
		}

		const cursor = editor.getCursor();
		this.settings.bookmarks[slot] = {
			file: file.path,
			line: cursor.line,
			ch: cursor.ch,
		};

		await this.saveSettings();
		new Notice(`Bookmark ${slot} saved.`);
	}

	private async goToBookmark(slot: string) {
		const bookmark = this.settings.bookmarks[slot];

		if (!bookmark) {
			new Notice(`Bookmark ${slot} is not set.`);
			return;
		}

		const target = this.app.vault.getAbstractFileByPath(bookmark.file);

		if (!(target instanceof TFile)) {
			new Notice(`File for bookmark ${slot} no longer exists.`);
			return;
		}

		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(target);

		const markdownView = leaf.view instanceof MarkdownView
			? leaf.view
			: this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!markdownView) {
			new Notice('Could not open a markdown editor for this bookmark.');
			return;
		}

		const editor = markdownView.editor;
		const maxLineIndex = Math.max(editor.lineCount() - 1, 0);
		const line = Math.min(Math.max(bookmark.line, 0), maxLineIndex);
		const lineLength = editor.getLine(line)?.length ?? 0;
		const ch = Math.min(Math.max(bookmark.ch, 0), lineLength);
		const position = { line, ch };

		editor.setCursor(position);
		editor.scrollIntoView({ from: position, to: position }, true);
	}

	private async loadSettings() {
		const data = (await this.loadData()) as Partial<BookmarkSettings> | null;
		this.settings = {
			bookmarks: Object.assign({}, DEFAULT_SETTINGS.bookmarks, data?.bookmarks ?? {}),
		};
	}

	private async saveSettings() {
		await this.saveData(this.settings);
	}
}
