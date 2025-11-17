import {
	App,
	Editor,
	ItemView,
	MarkdownView,
	MarkdownFileInfo,
	Notice,
	Modal,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
} from 'obsidian';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';

const VIEW_TYPE_BOOKMARKS = 'bookmark-line-with-hotkeys-view';

type BookmarkDecorationLineSpec = { line: number; classes: string };

const setBookmarkDecorations = StateEffect.define<BookmarkDecorationLineSpec[]>();

const bookmarkDecorationField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setBookmarkDecorations)) {
				const builder = new RangeSetBuilder<Decoration>();
				for (const spec of effect.value) {
					const lineNumber = Math.max(0, Math.min(tr.state.doc.lines - 1, spec.line));
					const lineInfo = tr.state.doc.line(lineNumber + 1);
					const decoration = Decoration.line({ class: spec.classes });
					builder.add(lineInfo.from, lineInfo.from, decoration);
				}
				deco = builder.finish();
			}
		}
		return deco;
	},
	provide: (field) => EditorView.decorations.from(field),
});

const bookmarkDecorationExtension: Extension = bookmarkDecorationField;

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

type LegacyCodeMirrorEditor = {
	addLineClass(line: number, where: 'wrap', className: string): void;
	removeLineClass(line: number, where: 'wrap', className: string): void;
};

type EditorWithCodeMirror = Editor & {
	cm?: LegacyCodeMirrorEditor;
	view?: EditorView;
};

function isLegacyCodeMirrorEditor(value: unknown): value is LegacyCodeMirrorEditor {
	return !!value
		&& typeof (value as LegacyCodeMirrorEditor).addLineClass === 'function'
		&& typeof (value as LegacyCodeMirrorEditor).removeLineClass === 'function';
}

export default class BookmarkLineWithHotkeysPlugin extends Plugin {
	settings: BookmarkSettings = DEFAULT_SETTINGS;
	private bookmarkViews = new Set<BookmarkListView>();
	private lineHighlights = new WeakMap<Editor, Map<number, Set<string>>>();
	private lastHighlightedEditor: Editor | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_BOOKMARKS, (leaf) => new BookmarkListView(leaf, this));
		this.registerCommands();
		this.registerWorkspaceEvents();

		this.app.workspace.onLayoutReady(() => {
			void this.activateBookmarkView(false);
			this.notifyBookmarkViews();
			this.refreshEditorHighlights();
			window.setTimeout(() => this.refreshEditorHighlights(), 0);
		});
	}

	onunload() {
		if (this.lastHighlightedEditor) {
			this.clearLineHighlights(this.lastHighlightedEditor);
			this.lastHighlightedEditor = null;
		}
	}

	private registerCommands() {
		for (let slot = 1; slot <= 9; slot++) {
			const slotKey = slot.toString();

			this.addCommand({
				id: `set-bookmark-${slot}`,
				name: `Set bookmark ${slot}`,
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
				callback: () => {
					void this.goToBookmark(slotKey);
				},
			});
		}

		this.addCommand({
			id: 'show-bookmark-list',
			name: 'Show bookmark list',
			callback: () => {
				void this.activateBookmarkView(true);
			},
		});
	}

	private async setBookmark(slot: string, editor: Editor, view: MarkdownView) {
		const file = view.file;
		if (!file) {
			new Notice('Unable to determine the current file.');
			return;
		}

		const existing = this.settings.bookmarks[slot];
		const cursor = editor.getCursor();

		if (existing && existing.file === file.path && existing.line === cursor.line && existing.ch === cursor.ch) {
			const confirmed = await this.confirmBookmarkRemoval(slot);
			if (!confirmed) {
				return;
			}

			delete this.settings.bookmarks[slot];
			await this.saveSettings();
			new Notice(`Bookmark ${slot} removed.`);
			this.refreshEditorHighlights();
			this.notifyBookmarkViews();
			return;
		}

		this.settings.bookmarks[slot] = {
			file: file.path,
			line: cursor.line,
			ch: cursor.ch,
		};

		await this.saveSettings();
		new Notice(existing ? `Bookmark ${slot} updated.` : `Bookmark ${slot} saved.`);
		this.refreshEditorHighlights();
		this.notifyBookmarkViews();
	}

	async removeBookmark(slot: string) {
		if (!this.settings.bookmarks[slot]) {
			return;
		}

		const confirmed = await this.confirmBookmarkRemoval(slot);
		if (!confirmed) {
			return;
		}

		delete this.settings.bookmarks[slot];
		await this.saveSettings();
		new Notice(`Bookmark ${slot} removed.`);
		this.refreshEditorHighlights();
		this.notifyBookmarkViews();
	}

	async goToBookmark(slot: string) {
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
			new Notice('Could not open markdown editor for this bookmark');  // skip eslint required by Notice
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
		this.refreshEditorHighlights();
		this.notifyBookmarkViews();
	}

	private registerWorkspaceEvents() {
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.refreshEditorHighlights();
				this.notifyBookmarkViews();
			}),
		);

		this.registerEvent(
			this.app.workspace.on('editor-change', (editor, info) => {
				const file = info instanceof MarkdownView
					? info.file
					: (info as MarkdownFileInfo | null)?.file ?? null;

				if (file instanceof TFile) {
					this.applyLineHighlights(editor, file);
				} else if (this.lastHighlightedEditor === editor) {
					this.clearLineHighlights(editor);
					if (this.lastHighlightedEditor === editor) {
						this.lastHighlightedEditor = null;
					}
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const view = leaf?.view instanceof MarkdownView
					? leaf.view
					: this.app.workspace.getActiveViewOfType(MarkdownView);

				if (view?.file) {
					this.applyLineHighlights(view.editor, view.file);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				void this.handleFileRename(file, oldPath);
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				void this.handleFileDelete(file);
			}),
		);
	}

	private async handleFileRename(file: TAbstractFile, oldPath: string) {
		if (!(file instanceof TFile)) {
			return;
		}

		let changed = false;

		for (const bookmark of Object.values(this.settings.bookmarks)) {
			if (bookmark.file === oldPath) {
				bookmark.file = file.path;
				changed = true;
			}
		}

		if (changed) {
			await this.saveSettings();
			this.refreshEditorHighlights();
			this.notifyBookmarkViews();
		}
	}

	private async handleFileDelete(file: TAbstractFile) {
		if (!(file instanceof TFile)) {
			return;
		}

		let changed = false;

		for (const [slot, bookmark] of Object.entries(this.settings.bookmarks)) {
			if (bookmark.file === file.path) {
				delete this.settings.bookmarks[slot];
				changed = true;
			}
		}

		if (changed) {
			await this.saveSettings();
			this.refreshEditorHighlights();
			this.notifyBookmarkViews();
		}
	}

	private refreshEditorHighlights() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) {
			if (this.lastHighlightedEditor) {
				this.clearLineHighlights(this.lastHighlightedEditor);
				this.lastHighlightedEditor = null;
			}
			return;
		}

		try {
			this.applyLineHighlights(view.editor, view.file);
		} catch (error) {
			console.error('Failed to apply bookmark highlights', error);
		}
	}

	registerBookmarkView(view: BookmarkListView) {
		this.bookmarkViews.add(view);
		void view.requestRender();
	}

	unregisterBookmarkView(view: BookmarkListView) {
		this.bookmarkViews.delete(view);
	}

	notifyBookmarkViews() {
		for (const view of this.bookmarkViews) {
			void view.requestRender();
		}
	}

	private applyLineHighlights(editor: Editor, file: TFile) {
		const editorWithCM = editor as EditorWithCodeMirror;
		const cmEditor = editorWithCM.cm ?? editorWithCM.view;
		const previousLineMap = this.lineHighlights.get(editor) ?? new Map<number, Set<string>>();

		if (this.lastHighlightedEditor && this.lastHighlightedEditor !== editor) {
			this.clearLineHighlights(this.lastHighlightedEditor);
		}

		const bookmarks = this.getSortedBookmarks()
			.filter(([, entry]) => entry.file === file.path);

		if (!cmEditor) {
			this.lineHighlights.delete(editor);
			return;
		}

		if (!bookmarks.length) {
			this.clearLineHighlights(editor);
			this.lastHighlightedEditor = editor;
			return;
		}

		const lineCount = editor.lineCount();
		const lineMap = new Map<number, Set<string>>();

		for (const [slot, entry] of bookmarks) {
			const safeLine = Math.min(Math.max(entry.line, 0), Math.max(lineCount - 1, 0));
			let slotsForLine = lineMap.get(safeLine);
			if (!slotsForLine) {
				slotsForLine = new Set<string>();
				lineMap.set(safeLine, slotsForLine);
			}
			slotsForLine.add(slot);
		}

		if (isLegacyCodeMirrorEditor(cmEditor)) {
			this.applyLineHighlightsCM5(cmEditor, lineMap, previousLineMap);
		} else if (cmEditor instanceof EditorView) {
			this.applyLineHighlightsCM6(cmEditor, lineMap);
		}

		this.lineHighlights.set(editor, lineMap);
		this.lastHighlightedEditor = editor;
	}

	private applyLineHighlightsCM5(
		cmEditor: LegacyCodeMirrorEditor,
		lineMap: Map<number, Set<string>>,
		previousLineMap: Map<number, Set<string>>,
	) {
		for (const [line, slots] of lineMap.entries()) {
			if (!previousLineMap.has(line)) {
				cmEditor.addLineClass(line, 'wrap', 'bookmark-line-highlight');
			}

			const previousSlots = previousLineMap.get(line) ?? new Set<string>();
			for (const slot of slots) {
				if (!previousSlots.has(slot)) {
					cmEditor.addLineClass(line, 'wrap', this.slotHighlightClass(slot));
				}
			}
		}

		for (const [line, slots] of previousLineMap.entries()) {
			const nextSlots = lineMap.get(line);
			if (!nextSlots) {
				cmEditor.removeLineClass(line, 'wrap', 'bookmark-line-highlight');
				for (const slot of slots) {
					cmEditor.removeLineClass(line, 'wrap', this.slotHighlightClass(slot));
				}
				continue;
			}

			for (const slot of slots) {
				if (!nextSlots.has(slot)) {
					cmEditor.removeLineClass(line, 'wrap', this.slotHighlightClass(slot));
				}
			}

			if (nextSlots.size === 0) {
				cmEditor.removeLineClass(line, 'wrap', 'bookmark-line-highlight');
			}
		}
	}

	private applyLineHighlightsCM6(view: EditorView, lineMap: Map<number, Set<string>>) {
		this.ensureBookmarkDecorationExtension(view);

		const specs: BookmarkDecorationLineSpec[] = Array.from(lineMap.entries())
			.sort((a, b) => a[0] - b[0])
			.map(([line, slots]) => {
				const slotClasses = Array.from(slots).sort().map((slot) => this.slotHighlightClass(slot));
				const classes = ['bookmark-line-highlight', ...slotClasses].join(' ');
				return { line, classes };
			});

		view.dispatch({
			effects: setBookmarkDecorations.of(specs),
		});
	}

	private ensureBookmarkDecorationExtension(view: EditorView) {
		if (!view.state.field(bookmarkDecorationField, false)) {
			view.dispatch({
				effects: StateEffect.appendConfig.of(bookmarkDecorationExtension),
			});
		}
	}

	private clearLineHighlights(editor: Editor) {
		const lineMap = this.lineHighlights.get(editor);
		const editorWithCM = editor as EditorWithCodeMirror;
		const cmEditor = editorWithCM.cm ?? editorWithCM.view;

		if (cmEditor && isLegacyCodeMirrorEditor(cmEditor) && lineMap) {
			for (const [line, slots] of lineMap.entries()) {
				cmEditor.removeLineClass(line, 'wrap', 'bookmark-line-highlight');
				for (const slot of slots) {
					cmEditor.removeLineClass(line, 'wrap', this.slotHighlightClass(slot));
				}
			}
		} else if (cmEditor instanceof EditorView) {
			this.ensureBookmarkDecorationExtension(cmEditor);
			cmEditor.dispatch({
				effects: setBookmarkDecorations.of([]),
			});
		}

		this.lineHighlights.delete(editor);
	}

	private slotHighlightClass(slot: string) {
		return `bookmark-line-highlight-slot-${slot}`;
	}

	private async confirmBookmarkRemoval(slot: string): Promise<boolean> {
		return new Promise((resolve) => {
			new ConfirmBookmarkRemovalModal(this.app, slot, resolve).open();
		});
	}

	getSortedBookmarks(): Array<[string, BookmarkEntry]> {
		return Object.entries(this.settings.bookmarks)
			.sort((a, b) => Number(a[0]) - Number(b[0]));
	}

	async getBookmarkPreview(entry: BookmarkEntry): Promise<string | null> {
		const abstractFile = this.app.vault.getAbstractFileByPath(entry.file);

		if (!(abstractFile instanceof TFile)) {
			return null;
		}

		try {
			const content = await this.app.vault.cachedRead(abstractFile);
			const lines = content.split(/\r?\n/);
			const line = lines[entry.line];
			return line?.trim() ?? '';
		} catch (error) {
			console.error('Failed to read file for bookmark preview', error);
			return null;
		}
	}

	async activateBookmarkView(reveal: boolean) {
		const workspace = this.app.workspace;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_BOOKMARKS);
		let leaf = leaves.length > 0 ? leaves[0] : undefined;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			if (!leaf) {
				return;
			}

			await leaf.setViewState({
				type: VIEW_TYPE_BOOKMARKS,
				active: reveal,
			});
		}

		if (reveal) {
			void workspace.revealLeaf(leaf);
		}
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

class BookmarkListView extends ItemView {
	private renderPromise: Promise<void> | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: BookmarkLineWithHotkeysPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_BOOKMARKS;
	}

	getDisplayText() {
		return 'Line bookmarks';
	}

	getIcon() {
		return 'bookmark';
	}

	async onOpen() { // skip eslint required by ItemView
		this.containerEl.addClass('bookmark-line-with-hotkeys-view');
		this.plugin.registerBookmarkView(this);
	}

	async onClose() { // skip eslint required by ItemView
		this.containerEl.removeClass('bookmark-line-with-hotkeys-view');
		this.plugin.unregisterBookmarkView(this);
	}

	requestRender() {
		if (!this.renderPromise) {
			this.renderPromise = this.render();
			this.renderPromise.finally(() => {
				this.renderPromise = null;
			}).catch(() => {
				this.renderPromise = null;
			});
		}

		return this.renderPromise;
	}

	private async render() {
		const container = this.containerEl;
		container.empty();

		const header = container.createDiv({ cls: 'bookmark-list-header' });
		header.createEl('h2', { text: 'Line bookmarks' });

		const bookmarks = this.plugin.getSortedBookmarks();

		if (!bookmarks.length) {
			container.createDiv({
				cls: 'bookmark-empty',
				text: 'No bookmarks yet. Use Mod+Shift+1..9 to save one.',
			});
			return;
		}

		const listEl = container.createDiv({ cls: 'bookmark-list' });
		const activeFile = this.plugin.app.workspace.getActiveFile();

		for (const [slot, bookmark] of bookmarks) {
			const itemEl = listEl.createDiv({ cls: 'bookmark-item clickable' });

			const file = this.plugin.app.vault.getAbstractFileByPath(bookmark.file);

			if (!(file instanceof TFile)) {
				itemEl.addClass('is-missing');
				const headerRow = itemEl.createDiv({ cls: 'bookmark-item-header' });
				headerRow.createDiv({ cls: 'bookmark-item-slot', text: slot });
				headerRow.createDiv({ cls: 'bookmark-item-file', text: bookmark.file });
				itemEl.createDiv({
					cls: 'bookmark-item-preview',
					text: 'File not found',
				});
				itemEl.onClickEvent(() => {
					new Notice(`File for bookmark ${slot} is missing.`);
				});
				continue;
			}

			if (activeFile?.path === bookmark.file) {
				itemEl.addClass('is-active');
			}

			const headerRow = itemEl.createDiv({ cls: 'bookmark-item-header' });
			headerRow.createDiv({ cls: 'bookmark-item-slot', text: slot });
			headerRow.createDiv({ cls: 'bookmark-item-file', text: file.basename });

			const removeButton = headerRow.createEl('button', {
				cls: 'bookmark-item-remove',
				text: '×',
				attr: { 'aria-label': `Remove bookmark ${slot}` },
			});

			removeButton.addEventListener('click', (event) => {
				event.stopPropagation();
				void this.plugin.removeBookmark(slot);
			});

			headerRow.createDiv({
				cls: 'bookmark-item-position',
				text: `Line ${bookmark.line + 1}`,
			});

			const preview = await this.plugin.getBookmarkPreview(bookmark);
			if (preview !== null) {
				itemEl.createDiv({
					cls: 'bookmark-item-preview',
					text: preview || '(blank line)',
				});
			}

			itemEl.onClickEvent(() => {
				void this.plugin.goToBookmark(slot);
			});
		}
	}
}

class ConfirmBookmarkRemovalModal extends Modal {
	constructor(app: App, private slot: string, private resolve: (confirmed: boolean) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h3', { text: 'Remove bookmark?' });
		contentEl.createEl('p', { text: `Do you want to remove bookmark ${this.slot}?` });

		const buttonBar = contentEl.createDiv({ cls: 'modal-button-container' });

		const cancelButton = buttonBar.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.resolve(false);
			this.close();
		});

		const confirmButton = buttonBar.createEl('button', {
			text: 'Remove',
			cls: 'mod-warning',
		});
		confirmButton.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
