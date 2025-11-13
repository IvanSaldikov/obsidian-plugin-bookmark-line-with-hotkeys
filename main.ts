import {
	Editor,
	ItemView,
	MarkdownView,
	MarkdownFileInfo,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
} from 'obsidian';

const VIEW_TYPE_BOOKMARKS = 'bookmark-line-with-hotkeys-view';

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
	private styleEl: HTMLStyleElement | null = null;
	private bookmarkViews = new Set<BookmarkListView>();
	private lineHighlights = new WeakMap<Editor, Map<number, Set<string>>>();
	private lastHighlightedEditor: Editor | null = null;
	private editorChangeTimeout: ReturnType<typeof setTimeout> | null = null;

	async onload() {
		await this.loadSettings();
		this.injectStyles();

		this.registerView(VIEW_TYPE_BOOKMARKS, (leaf) => new BookmarkListView(leaf, this));
		this.registerCommands();
		this.registerWorkspaceEvents();

		this.app.workspace.onLayoutReady(() => {
			void this.activateBookmarkView(false);
			this.notifyBookmarkViews();
			this.refreshEditorHighlights();
		});
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_BOOKMARKS);

		if (this.lastHighlightedEditor) {
			this.clearLineHighlights(this.lastHighlightedEditor);
			this.lastHighlightedEditor = null;
		}

		if (this.styleEl?.parentElement) {
			this.styleEl.parentElement.removeChild(this.styleEl);
		}
		this.styleEl = null;
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

		const cursor = editor.getCursor();
		this.settings.bookmarks[slot] = {
			file: file.path,
			line: cursor.line,
			ch: cursor.ch,
		};

		await this.saveSettings();
		new Notice(`Bookmark ${slot} saved.`);
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
			this.notifyBookmarkViews();
			this.refreshEditorHighlights();
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
			this.notifyBookmarkViews();
			this.refreshEditorHighlights();
		}
	}

	private refreshEditorHighlights() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!view || !view.file) {
			if (this.lastHighlightedEditor) {
				this.clearLineHighlights(this.lastHighlightedEditor);
				this.lastHighlightedEditor = null;
			}
			return;
		}

		this.applyLineHighlights(view.editor, view.file);
	}

	private applyLineHighlights(editor: Editor, file: TFile) {
		// Access the CodeMirror editor view through the editor's internal structure
		const cmEditor = (editor as any).cm;
		if (!cmEditor) {
			// Try alternative access path
			const view = (editor as any).view;
			if (!view) {
				console.warn('Could not access CodeMirror editor instance');
				return;
			}
			return this.applyLineHighlightsViaDOM(editor, file, view);
		}

		if (this.lastHighlightedEditor && this.lastHighlightedEditor !== editor) {
			this.clearLineHighlights(this.lastHighlightedEditor);
		}

		this.clearLineHighlights(editor);

		const bookmarks = this.getSortedBookmarks()
			.filter(([, entry]) => entry.file === file.path);

		if (!bookmarks.length) {
			this.lastHighlightedEditor = editor;
			return;
		}

		// Try CodeMirror 5 API (older Obsidian versions)
		if (typeof cmEditor.addLineClass === 'function') {
			const lineCount = editor.lineCount();
			const lineMap = new Map<number, Set<string>>();

			for (const [slot, entry] of bookmarks) {
				const safeLine = Math.min(Math.max(entry.line, 0), Math.max(lineCount - 1, 0));

				let slotsForLine = lineMap.get(safeLine);
				if (!slotsForLine) {
					slotsForLine = new Set<string>();
					lineMap.set(safeLine, slotsForLine);
					cmEditor.addLineClass(safeLine, 'wrap', 'bookmark-line-highlight');
				}

				cmEditor.addLineClass(safeLine, 'wrap', this.slotHighlightClass(slot));
				slotsForLine.add(slot);
			}

			this.lineHighlights.set(editor, lineMap);
			this.lastHighlightedEditor = editor;
			return;
		}

		// Fallback to DOM manipulation for CodeMirror 6
		this.applyLineHighlightsViaDOM(editor, file, cmEditor);
	}

	private applyLineHighlightsViaDOM(editor: Editor, file: TFile, cmEditor: any) {
		// Find the editor's DOM container - try multiple access paths
		let editorEl: HTMLElement | null = null;
		
		// Try accessing through the view
		if (cmEditor?.dom) {
			editorEl = cmEditor.dom;
		} else if (cmEditor?.contentDOM) {
			editorEl = cmEditor.contentDOM.parentElement;
		} else if ((editor as any).containerEl) {
			editorEl = (editor as any).containerEl;
		} else {
			// Try to find the editor container in the active view
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
				const editorContainer = (view as any).editorEl ?? (view as any).editor?.containerEl;
				if (editorContainer) {
					editorEl = editorContainer;
				}
			}
		}

		if (!editorEl) {
			console.warn('Could not find editor DOM element. Available:', {
				cmEditor: !!cmEditor,
				hasView: !!this.app.workspace.getActiveViewOfType(MarkdownView),
			});
			return;
		}

		// Clear existing highlights first
		this.clearLineHighlightsViaDOM(editorEl);

		const bookmarks = this.getSortedBookmarks()
			.filter(([, entry]) => entry.file === file.path);

		if (!bookmarks.length) {
			this.lastHighlightedEditor = editor;
			return;
		}

		const lineCount = editor.lineCount();
		const lineMap = new Map<number, Set<string>>();

		// Wait a bit for DOM to be ready, then apply highlights
		setTimeout(() => {
			for (const [slot, entry] of bookmarks) {
				const safeLine = Math.min(Math.max(entry.line, 0), Math.max(lineCount - 1, 0));

				// Find the line element in the DOM
				const lineEl = this.findLineElement(editorEl!, safeLine);
				if (lineEl) {
					let slotsForLine = lineMap.get(safeLine);
					if (!slotsForLine) {
						slotsForLine = new Set<string>();
						lineMap.set(safeLine, slotsForLine);
						lineEl.classList.add('bookmark-line-highlight');
					}

					lineEl.classList.add(this.slotHighlightClass(slot));
					slotsForLine.add(slot);
				} else {
					console.warn(`Could not find line element for line ${safeLine}`);
				}
			}

			this.lineHighlights.set(editor, lineMap);
			this.lastHighlightedEditor = editor;
		}, 50);
	}

	private findLineElement(container: HTMLElement, lineNumber: number): HTMLElement | null {
		// Try CodeMirror 6 structure (.cm-line)
		const cmLines = container.querySelectorAll('.cm-line');
		if (cmLines.length > lineNumber) {
			return cmLines[lineNumber] as HTMLElement;
		}

		// Try CodeMirror 5 structure (.CodeMirror-line)
		const codeMirrorLines = container.querySelectorAll('.CodeMirror-line');
		if (codeMirrorLines.length > lineNumber) {
			return codeMirrorLines[lineNumber] as HTMLElement;
		}

		// Fallback: try to find by data-line attribute
		const lineByAttr = container.querySelector(`[data-line="${lineNumber}"]`);
		if (lineByAttr) {
			return lineByAttr as HTMLElement;
		}

		return null;
	}

	private clearLineHighlights(editor: Editor) {
		const lineMap = this.lineHighlights.get(editor);
		if (!lineMap) {
			return;
		}

		const cmEditor = (editor as any).cm;
		
		// Try CodeMirror 5 API
		if (cmEditor && typeof cmEditor.removeLineClass === 'function') {
			for (const [line, slots] of lineMap.entries()) {
				cmEditor.removeLineClass(line, 'wrap', 'bookmark-line-highlight');
				for (const slot of slots) {
					cmEditor.removeLineClass(line, 'wrap', this.slotHighlightClass(slot));
				}
			}
			this.lineHighlights.delete(editor);
			return;
		}

		// Fallback to DOM manipulation
		const view = (editor as any).view;
		const editorEl = cmEditor?.dom ?? cmEditor?.contentDOM ?? view?.dom ?? (editor as any).containerEl;
		if (editorEl) {
			this.clearLineHighlightsViaDOM(editorEl);
		}

		this.lineHighlights.delete(editor);
	}

	private clearLineHighlightsViaDOM(container: HTMLElement) {
		// Remove all bookmark highlight classes from all lines
		const highlightedLines = container.querySelectorAll('.bookmark-line-highlight');
		for (const line of Array.from(highlightedLines)) {
			line.classList.remove('bookmark-line-highlight');
			for (let i = 1; i <= 9; i++) {
				line.classList.remove(this.slotHighlightClass(i.toString()));
			}
		}
	}

	private slotHighlightClass(slot: string) {
		return `bookmark-line-highlight-slot-${slot}`;
	}

	registerBookmarkView(view: BookmarkListView) {
		this.bookmarkViews.add(view);
		view.requestRender();
	}

	unregisterBookmarkView(view: BookmarkListView) {
		this.bookmarkViews.delete(view);
	}

	notifyBookmarkViews() {
		for (const view of this.bookmarkViews) {
			view.requestRender();
		}

		this.refreshEditorHighlights();
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
			workspace.revealLeaf(leaf);
		}
	}

	private injectStyles() {
		const style = document.createElement('style');
		style.id = 'bookmark-line-with-hotkeys-styles';
		style.textContent = `
.bookmark-line-with-hotkeys-view {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-2);
	padding: var(--size-4-3);
}

.bookmark-line-with-hotkeys-view .bookmark-list-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.bookmark-line-with-hotkeys-view .bookmark-list-header h2 {
	margin: 0;
	font-size: var(--font-ui-large);
	font-weight: 600;
}

.bookmark-line-with-hotkeys-view .bookmark-empty {
	color: var(--text-muted);
}

.bookmark-line-with-hotkeys-view .bookmark-list {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-2);
}

.bookmark-line-with-hotkeys-view .bookmark-item {
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-m);
	padding: var(--size-4-3);
	display: flex;
	flex-direction: column;
	gap: var(--size-2-2);
	cursor: pointer;
	background-color: var(--background-primary);
	transition: background-color 0.15s ease;
}

.bookmark-line-with-hotkeys-view .bookmark-item:hover {
	background-color: var(--background-primary-alt);
}

.bookmark-line-with-hotkeys-view .bookmark-item.is-active {
	border-color: var(--interactive-accent);
}

.bookmark-line-with-hotkeys-view .bookmark-item.is-missing {
	opacity: 0.7;
}

.bookmark-line-with-hotkeys-view .bookmark-item-header {
	display: flex;
	align-items: center;
	gap: var(--size-2-2);
}

.bookmark-line-with-hotkeys-view .bookmark-item-slot {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 1.6em;
	height: 1.6em;
	border-radius: 999px;
	background-color: var(--interactive-accent);
	color: var(--text-on-accent);
	font-weight: 600;
	font-size: 0.9em;
}

.bookmark-line-with-hotkeys-view .bookmark-item-file {
	font-weight: 600;
}

.bookmark-line-with-hotkeys-view .bookmark-item-position {
	margin-left: auto;
	color: var(--text-muted);
	font-size: 0.9em;
}

.bookmark-line-with-hotkeys-view .bookmark-item-preview {
	font-size: 0.9em;
	color: var(--text-muted);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.cm-line.bookmark-line-highlight,
.CodeMirror-line.bookmark-line-highlight {
	position: relative;
	background-color: var(--background-modifier-hover);
	border-left: 0.25em solid var(--interactive-accent);
	border-radius: 0 6px 6px 0;
	padding-left: 0.4em;
}

.cm-line.bookmark-line-highlight::before,
.CodeMirror-line.bookmark-line-highlight::before {
	content: '';
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 1.4em;
	height: 1.4em;
	margin-right: 0.45em;
	border-radius: 999px;
	background-color: var(--interactive-accent);
	color: var(--text-on-accent);
	font-size: 0.8em;
	font-weight: 600;
}

.cm-line.bookmark-line-highlight-slot-1::before,
.CodeMirror-line.bookmark-line-highlight-slot-1::before { content: '1'; }
.cm-line.bookmark-line-highlight-slot-2::before,
.CodeMirror-line.bookmark-line-highlight-slot-2::before { content: '2'; }
.cm-line.bookmark-line-highlight-slot-3::before,
.CodeMirror-line.bookmark-line-highlight-slot-3::before { content: '3'; }
.cm-line.bookmark-line-highlight-slot-4::before,
.CodeMirror-line.bookmark-line-highlight-slot-4::before { content: '4'; }
.cm-line.bookmark-line-highlight-slot-5::before,
.CodeMirror-line.bookmark-line-highlight-slot-5::before { content: '5'; }
.cm-line.bookmark-line-highlight-slot-6::before,
.CodeMirror-line.bookmark-line-highlight-slot-6::before { content: '6'; }
.cm-line.bookmark-line-highlight-slot-7::before,
.CodeMirror-line.bookmark-line-highlight-slot-7::before { content: '7'; }
.cm-line.bookmark-line-highlight-slot-8::before,
.CodeMirror-line.bookmark-line-highlight-slot-8::before { content: '8'; }
.cm-line.bookmark-line-highlight-slot-9::before,
.CodeMirror-line.bookmark-line-highlight-slot-9::before { content: '9'; }
`;
		document.head.appendChild(style);
		this.styleEl = style;
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
		return 'Line Bookmarks';
	}

	getIcon() {
		return 'bookmark';
	}

	async onOpen() {
		this.containerEl.addClass('bookmark-line-with-hotkeys-view');
		this.plugin.registerBookmarkView(this);
	}

	async onClose() {
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
		header.createEl('h2', { text: 'Line Bookmarks' });

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
			const itemEl = listEl.createDiv({ cls: 'bookmark-item' });

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

