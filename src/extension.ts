import * as vscode from 'vscode';

const STORAGE_KEY = 'savedLayouts';
const SCHEMA_VERSION = 1;

type EditorLayoutState = Record<string, unknown>;

interface LayoutCommandArgs {
	name?: string;
}

interface SavedLayout {
	version: number;
	name: string;
	savedAt: string;
	editorLayout: EditorLayoutState;
	activeGroupIndex: number;
	groups: SavedGroup[];
	skippedTabs: SkippedTab[];
}

interface SavedGroup {
	index: number;
	viewColumn: number | null;
	activeTabIndex: number;
	tabs: SavedTab[];
}

interface SavedTabBase {
	kind: 'text' | 'textDiff' | 'notebook' | 'notebookDiff' | 'custom';
	label: string;
	isPreview: boolean;
	isPinned: boolean;
}

interface SavedTextTab extends SavedTabBase {
	kind: 'text';
	uri: string;
}

interface SavedTextDiffTab extends SavedTabBase {
	kind: 'textDiff';
	original: string;
	modified: string;
}

interface SavedNotebookTab extends SavedTabBase {
	kind: 'notebook';
	uri: string;
	notebookType: string;
}

interface SavedNotebookDiffTab extends SavedTabBase {
	kind: 'notebookDiff';
	original: string;
	modified: string;
	notebookType: string;
}

interface SavedCustomTab extends SavedTabBase {
	kind: 'custom';
	uri: string;
	viewType: string;
}

type SavedTab =
	| SavedTextTab
	| SavedTextDiffTab
	| SavedNotebookTab
	| SavedNotebookDiffTab
	| SavedCustomTab;

interface SkippedTab {
	label: string;
	reason: string;
}

interface LayoutQuickPickItem extends vscode.QuickPickItem {
	layout: SavedLayout;
}

export function activate(context: vscode.ExtensionContext): void {
	const store = new LayoutStore(context.globalState);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscodeLayouts.saveLayout', async () => {
			await saveLayout(store);
		}),
		vscode.commands.registerCommand('vscodeLayouts.applyLayout', async (args?: LayoutCommandArgs) => {
			await applyLayout(store, args);
		}),
		vscode.commands.registerCommand('vscodeLayouts.deleteLayout', async () => {
			await deleteLayout(store);
		}),
		vscode.commands.registerCommand('vscodeLayouts.listLayouts', async () => {
			await listLayouts(store);
		})
	);
}

export function deactivate(): void {}

class LayoutStore {
	constructor(private readonly globalState: vscode.Memento) {}

	async getAll(): Promise<SavedLayout[]> {
		const raw = this.globalState.get<unknown>(STORAGE_KEY, []);
		if (!Array.isArray(raw)) {
			return [];
		}

		return raw.filter(isSavedLayout).sort((left, right) => left.name.localeCompare(right.name));
	}

	async getByName(name: string): Promise<SavedLayout | undefined> {
		const normalizedName = normalizeName(name);
		const layouts = await this.getAll();
		return layouts.find((layout) => layout.name.toLowerCase() === normalizedName.toLowerCase());
	}

	async save(layout: SavedLayout): Promise<void> {
		const layouts = await this.getAll();
		const targetName = layout.name.toLowerCase();
		const nextLayouts = layouts.filter((entry) => entry.name.toLowerCase() !== targetName);
		nextLayouts.push(layout);
		nextLayouts.sort((left, right) => left.name.localeCompare(right.name));
		await this.globalState.update(STORAGE_KEY, nextLayouts);
	}

	async delete(name: string): Promise<boolean> {
		const layouts = await this.getAll();
		const targetName = name.toLowerCase();
		const nextLayouts = layouts.filter((entry) => entry.name.toLowerCase() !== targetName);
		if (nextLayouts.length === layouts.length) {
			return false;
		}

		await this.globalState.update(STORAGE_KEY, nextLayouts);
		return true;
	}
}

async function saveLayout(store: LayoutStore): Promise<void> {
	const editorLayout = await vscode.commands.executeCommand<EditorLayoutState>('vscode.getEditorLayout');
	if (!editorLayout || typeof editorLayout !== 'object') {
		vscode.window.showErrorMessage('VS Code Layouts could not read the current editor layout.');
		return;
	}

	const orderedGroups = getOrderedTabGroups();
	const activeGroup = vscode.window.tabGroups.activeTabGroup;
	const activeGroupIndex = orderedGroups.findIndex((group) => group === activeGroup);
	const groups = orderedGroups.map((group, index) => {
		const tabs: SavedTab[] = [];
		const skippedTabs: SkippedTab[] = [];

		group.tabs.forEach((tab) => {
			const savedTab = serializeTab(tab);
			if (savedTab) {
				tabs.push(savedTab);
				return;
			}

			skippedTabs.push({
				label: tab.label,
				reason: describeUnsupportedTab(tab.input)
			});
		});

			return {
				group: {
					index,
					viewColumn: group.viewColumn ?? null,
					activeTabIndex: group.tabs.findIndex((tab) => tab.isActive),
					tabs
				},
				skippedTabs
			};
	});

	const flatSkippedTabs = groups.flatMap((group) => group.skippedTabs);
	const layout = {
		editorLayout,
		groups: groups.map((group) => group.group),
		skippedTabs: flatSkippedTabs
	};

	const suggestedName = buildSuggestedName();
	const inputName = await vscode.window.showInputBox({
		title: 'Save Layout',
		prompt: 'Enter a name for this layout',
		placeHolder: suggestedName,
		value: suggestedName,
		ignoreFocusOut: true,
		validateInput: (value) => {
			return normalizeName(value).length === 0 ? 'A layout name is required.' : undefined;
		}
	});

	if (inputName === undefined) {
		return;
	}

	const name = normalizeName(inputName);
	const existing = await store.getByName(name);
	if (existing) {
		const overwrite = await vscode.window.showWarningMessage(
			`Layout "${name}" already exists.`,
			{ modal: true },
			'Overwrite'
		);
		if (overwrite !== 'Overwrite') {
			return;
		}
	}

	await store.save({
		version: SCHEMA_VERSION,
		name,
		savedAt: new Date().toISOString(),
		editorLayout: layout.editorLayout,
		activeGroupIndex,
		groups: layout.groups,
		skippedTabs: layout.skippedTabs
	});

	if (flatSkippedTabs.length > 0) {
		void vscode.window.showWarningMessage(
			`Layout "${name}" saved. ${flatSkippedTabs.length} tab(s) were skipped because VS Code does not expose a reopen path for them.`
		);
		return;
	}

	void vscode.window.showInformationMessage(`Layout "${name}" saved.`);
}

async function applyLayout(store: LayoutStore, args?: LayoutCommandArgs): Promise<void> {
	const layouts = await store.getAll();
	if (layouts.length === 0) {
		vscode.window.showInformationMessage('No saved layouts found.');
		return;
	}

	const requestedName = typeof args?.name === 'string' ? normalizeName(args.name) : '';
	const layout = requestedName.length > 0 ? await store.getByName(requestedName) : await pickLayout(layouts, 'Select a layout to apply');

	if (!layout) {
		if (requestedName.length > 0) {
			vscode.window.showErrorMessage(`Layout "${requestedName}" was not found.`);
		}
		return;
	}

	if (layout.version !== SCHEMA_VERSION) {
		vscode.window.showErrorMessage(
			`Layout "${layout.name}" uses schema version ${layout.version}, but this extension only supports version ${SCHEMA_VERSION}.`
		);
		return;
	}

	const dirtyTabs = getOrderedTabGroups().flatMap((group) => group.tabs).filter((tab) => tab.isDirty);
	if (dirtyTabs.length > 0) {
		const choice = await vscode.window.showWarningMessage(
			`Applying "${layout.name}" will close the current editors. Save all dirty files first?`,
			{ modal: true },
			'Save All and Apply'
		);
		if (choice !== 'Save All and Apply') {
			return;
		}

		const saveSucceeded = await vscode.workspace.saveAll();
		if (!saveSucceeded) {
			vscode.window.showWarningMessage(`Layout "${layout.name}" was not applied because not all dirty files were saved.`);
			return;
		}
	}

	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await vscode.commands.executeCommand('vscode.setEditorLayout', layout.editorLayout);
	await waitForWorkbench();

	const targetGroups = getOrderedTabGroups();
	for (const savedGroup of layout.groups) {
		const targetGroup = targetGroups[savedGroup.index];
		if (!targetGroup) {
			continue;
		}

		for (const tab of getRestoreOrder(savedGroup)) {
			try {
				await openSavedTab(tab, targetGroup.viewColumn, true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showWarningMessage(`Could not reopen "${tab.label}": ${message}`);
			}
		}
	}

	const activeTargetGroup = layout.groups[layout.activeGroupIndex];
	if (activeTargetGroup) {
		const activeTab = activeTargetGroup.tabs[activeTargetGroup.activeTabIndex];
		const targetGroup = targetGroups[activeTargetGroup.index];
		if (targetGroup) {
			try {
				await openSavedTab(activeTab, targetGroup.viewColumn, false);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showWarningMessage(`Could not focus the active tab "${activeTab.label}": ${message}`);
			}
		}
	}

	if (layout.skippedTabs.length > 0) {
		void vscode.window.showWarningMessage(
			`Layout "${layout.name}" applied. ${layout.skippedTabs.length} tab(s) were not restored because they were skipped when the layout was saved.`
		);
		return;
	}

	void vscode.window.showInformationMessage(`Layout "${layout.name}" applied.`);
}

async function deleteLayout(store: LayoutStore): Promise<void> {
	const layouts = await store.getAll();
	if (layouts.length === 0) {
		vscode.window.showInformationMessage('No saved layouts found.');
		return;
	}

	const layout = await pickLayout(layouts, 'Select a layout to delete');
	if (!layout) {
		return;
	}

	const confirmation = await vscode.window.showWarningMessage(
		`Delete layout "${layout.name}"?`,
		{ modal: true },
		'Delete'
	);
	if (confirmation !== 'Delete') {
		return;
	}

	await store.delete(layout.name);
	void vscode.window.showInformationMessage(`Layout "${layout.name}" deleted.`);
}

async function listLayouts(store: LayoutStore): Promise<void> {
	const layouts = await store.getAll();
	if (layouts.length === 0) {
		vscode.window.showInformationMessage('No saved layouts found.');
		return;
	}

	await pickLayout(layouts, 'Saved layouts');
}

function serializeTab(tab: vscode.Tab): SavedTab | undefined {
	const input = tab.input;

	if (input instanceof vscode.TabInputText) {
		return {
			kind: 'text',
			label: tab.label,
			isPreview: tab.isPreview,
			isPinned: tab.isPinned,
			uri: input.uri.toString()
		};
	}

	if (input instanceof vscode.TabInputTextDiff) {
		return {
			kind: 'textDiff',
			label: tab.label,
			isPreview: tab.isPreview,
			isPinned: tab.isPinned,
			original: input.original.toString(),
			modified: input.modified.toString()
		};
	}

	if (input instanceof vscode.TabInputNotebook) {
		return {
			kind: 'notebook',
			label: tab.label,
			isPreview: tab.isPreview,
			isPinned: tab.isPinned,
			uri: input.uri.toString(),
			notebookType: input.notebookType
		};
	}

	if (input instanceof vscode.TabInputNotebookDiff) {
		return {
			kind: 'notebookDiff',
			label: tab.label,
			isPreview: tab.isPreview,
			isPinned: tab.isPinned,
			original: input.original.toString(),
			modified: input.modified.toString(),
			notebookType: input.notebookType
		};
	}

	if (input instanceof vscode.TabInputCustom) {
		return {
			kind: 'custom',
			label: tab.label,
			isPreview: tab.isPreview,
			isPinned: tab.isPinned,
			uri: input.uri.toString(),
			viewType: input.viewType
		};
	}

	return undefined;
}

async function openSavedTab(tab: SavedTab, viewColumn: vscode.ViewColumn | undefined, preserveFocus: boolean): Promise<void> {
	switch (tab.kind) {
		case 'text': {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(tab.uri));
			await vscode.window.showTextDocument(document, {
				viewColumn,
				preserveFocus,
				preview: false
			});
			return;
		}

		case 'textDiff': {
			await vscode.commands.executeCommand(
				'vscode.diff',
				vscode.Uri.parse(tab.original),
				vscode.Uri.parse(tab.modified),
				tab.label,
				{
					viewColumn,
					preserveFocus,
					preview: false
				}
			);
			return;
		}

		case 'notebook': {
			const document = await vscode.workspace.openNotebookDocument(vscode.Uri.parse(tab.uri));
			await vscode.window.showNotebookDocument(document, {
				viewColumn,
				preserveFocus
			});
			return;
		}

		case 'notebookDiff': {
			await vscode.commands.executeCommand(
				'vscode.diff',
				vscode.Uri.parse(tab.original),
				vscode.Uri.parse(tab.modified),
				tab.label,
				{
					viewColumn,
					preserveFocus,
					preview: false
				}
			);
			return;
		}

		case 'custom': {
			await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(tab.uri), tab.viewType, {
				viewColumn,
				preserveFocus,
				preview: false
			});
		}
	}
}

function getOrderedTabGroups(): readonly vscode.TabGroup[] {
	return [...vscode.window.tabGroups.all].sort((left, right) => {
		const leftColumn = left.viewColumn ?? Number.MAX_SAFE_INTEGER;
		const rightColumn = right.viewColumn ?? Number.MAX_SAFE_INTEGER;
		return leftColumn - rightColumn;
	});
}

async function pickLayout(layouts: SavedLayout[], placeHolder: string): Promise<SavedLayout | undefined> {
	const items: LayoutQuickPickItem[] = layouts.map((layout) => ({
		label: layout.name,
		description: formatSavedAt(layout.savedAt),
		detail: `${countSavedTabs(layout)} tab(s) across ${layout.groups.length} group(s)`,
		layout
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder,
		matchOnDescription: true,
		matchOnDetail: true,
		ignoreFocusOut: true
	});

	return selected?.layout;
}

function countSavedTabs(layout: SavedLayout): number {
	return layout.groups.reduce((count, group) => count + group.tabs.length, 0);
}

function getRestoreOrder(group: SavedGroup): SavedTab[] {
	if (group.activeTabIndex < 0 || group.activeTabIndex >= group.tabs.length) {
		return group.tabs;
	}

	return group.tabs.filter((_, index) => index !== group.activeTabIndex).concat(group.tabs[group.activeTabIndex]);
}

function buildSuggestedName(): string {
	return `Layout ${new Date().toLocaleString()}`;
}

function normalizeName(value: string): string {
	return value.trim();
}

function describeUnsupportedTab(input: unknown): string {
	if (input instanceof vscode.TabInputTerminal) {
		return 'terminal tabs are not restorable through the extension API';
	}

	if (input instanceof vscode.TabInputWebview) {
		return `webview tabs for "${input.viewType}" cannot be reopened generically`;
	}

	if (input === undefined || input === null) {
		return 'the tab input is not available';
	}

	return `unsupported tab input type "${input.constructor?.name ?? typeof input}"`;
}

function isSavedLayout(value: unknown): value is SavedLayout {
	if (!isObject(value)) {
		return false;
	}

	return (
		typeof value.version === 'number' &&
		typeof value.name === 'string' &&
		typeof value.savedAt === 'string' &&
		isObject(value.editorLayout) &&
		typeof value.activeGroupIndex === 'number' &&
		Array.isArray(value.groups) &&
		value.groups.every(isSavedGroup) &&
		Array.isArray(value.skippedTabs) &&
		value.skippedTabs.every(isSkippedTab)
	);
}

function isSavedGroup(value: unknown): value is SavedGroup {
	if (!isObject(value)) {
		return false;
	}

	return (
		typeof value.index === 'number' &&
		(typeof value.viewColumn === 'number' || value.viewColumn === null) &&
		typeof value.activeTabIndex === 'number' &&
		Array.isArray(value.tabs) &&
		value.tabs.every(isSavedTab)
	);
}

function isSavedTab(value: unknown): value is SavedTab {
	if (!isObject(value) || typeof value.kind !== 'string') {
		return false;
	}

	if (
		typeof value.label !== 'string' ||
		typeof value.isPreview !== 'boolean' ||
		typeof value.isPinned !== 'boolean'
	) {
		return false;
	}

	switch (value.kind) {
		case 'text':
			return typeof value.uri === 'string';
		case 'textDiff':
			return typeof value.original === 'string' && typeof value.modified === 'string';
		case 'notebook':
			return typeof value.uri === 'string' && typeof value.notebookType === 'string';
		case 'notebookDiff':
			return (
				typeof value.original === 'string' &&
				typeof value.modified === 'string' &&
				typeof value.notebookType === 'string'
			);
		case 'custom':
			return typeof value.uri === 'string' && typeof value.viewType === 'string';
		default:
			return false;
	}
}

function isSkippedTab(value: unknown): value is SkippedTab {
	return isObject(value) && typeof value.label === 'string' && typeof value.reason === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function formatSavedAt(savedAt: string): string {
	const date = new Date(savedAt);
	return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString();
}

function waitForWorkbench(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 50);
	});
}
