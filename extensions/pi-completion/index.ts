import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	SelectList,
	getKeybindings,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type EditorComponent,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const BLANK_VALUE_PREFIX = "__pi_completion_blank__";
const DEFAULT_MAX_VISIBLE = 5;
const PATCH_MARK = Symbol.for("pi-completion.select-list-render-v2-patched");
const PROVIDER_MARK = Symbol.for("pi-completion.provider-v1");
const EDITOR_FACTORY_MARK = Symbol.for("pi-completion.editor-factory-v1");
const EDITOR_FACTORY_BASE = Symbol.for("pi-completion.editor-factory-base-v1");
const EDITOR_MARK = Symbol.for("pi-completion.editor-v1");

type ApplyResult = { lines: string[]; cursorLine: number; cursorCol: number };

type CompletionEditorFactory = ((
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => EditorComponent) & {
	[EDITOR_FACTORY_MARK]?: boolean;
	[EDITOR_FACTORY_BASE]?: CompletionEditorFactory;
};

type MarkedAutocompleteProvider = AutocompleteProvider & {
	[PROVIDER_MARK]?: boolean;
};

type AnyEditor = EditorComponent & {
	[EDITOR_MARK]?: boolean;
	handleInput?(data: string): void;
	createAutocompleteList?(
		prefix: string,
		items: AutocompleteItem[],
	): SelectList;
	runAutocompleteRequest?(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void>;
	cancelAutocomplete?(): void;
	clearAutocompleteUi?(): void;
	[key: string]: any;
};

function isBlankItem(item: AutocompleteItem | null | undefined): boolean {
	return (
		typeof item?.value === "string" && item.value.startsWith(BLANK_VALUE_PREFIX)
	);
}

function blankItem(index: number): AutocompleteItem {
	return { value: `${BLANK_VALUE_PREFIX}${index}`, label: "" };
}

function completionSource(prefix: string): string {
	if (prefix.startsWith("/")) return "slash";
	return "path";
}

function padLines(lines: string[], targetHeight: number): string[] {
	if (targetHeight <= lines.length) return lines;
	return [
		...lines,
		...Array.from({ length: targetHeight - lines.length }, () => ""),
	];
}

function patchSelectListBlankRows() {
	const proto = SelectList.prototype as any as {
		[PATCH_MARK]?: boolean;
		renderItem?: (...args: any[]) => string;
		render?: (width: number) => string[];
	};
	if (
		proto[PATCH_MARK] ||
		typeof proto.renderItem !== "function" ||
		typeof proto.render !== "function"
	)
		return;

	const originalRenderItem = proto.renderItem;
	const originalRender = proto.render;

	proto.renderItem = function patchedRenderItem(
		item: AutocompleteItem,
		...rest: any[]
	) {
		if (isBlankItem(item)) return "";
		return originalRenderItem.call(this, item, ...rest);
	};

	proto.render = function patchedRender(this: any, width: number) {
		const lines = originalRender.call(this, width);
		const filteredItems = Array.isArray(this.filteredItems)
			? this.filteredItems
			: [];
		const maxVisible =
			typeof this.maxVisible === "number"
				? this.maxVisible
				: DEFAULT_MAX_VISIBLE;
		const overflowOnlyBlank =
			filteredItems.length > maxVisible &&
			filteredItems
				.slice(maxVisible)
				.every((item: AutocompleteItem) => isBlankItem(item));

		if (!overflowOnlyBlank) return lines;

		const withoutScrollInfo = lines.slice(
			0,
			Math.min(lines.length, maxVisible),
		);
		return padLines(
			withoutScrollInfo,
			Math.min(filteredItems.length, maxVisible + 1),
		);
	};

	proto[PATCH_MARK] = true;
}

function stableSuggestionsProvider(
	current: AutocompleteProvider,
): AutocompleteProvider {
	if ((current as MarkedAutocompleteProvider)[PROVIDER_MARK]) return current;

	let stickyCount = 0;
	let activeSource: string | undefined;

	function reset() {
		stickyCount = 0;
		activeSource = undefined;
	}

	function padSuggestions(
		suggestions: AutocompleteSuggestions,
	): AutocompleteSuggestions {
		const source = completionSource(suggestions.prefix);
		if (activeSource && activeSource !== source) reset();
		activeSource = source;

		const visibleCount = Math.min(
			suggestions.items.length,
			DEFAULT_MAX_VISIBLE,
		);
		const hasScrollInfoRow = suggestions.items.length > DEFAULT_MAX_VISIBLE;
		const renderedRowCount = visibleCount + (hasScrollInfoRow ? 1 : 0);
		stickyCount = Math.max(stickyCount, renderedRowCount);

		const missing = Math.max(0, stickyCount - suggestions.items.length);
		if (missing === 0) return suggestions;

		return {
			prefix: suggestions.prefix,
			items: [
				...suggestions.items,
				...Array.from({ length: missing }, (_, index) => blankItem(index)),
			],
		};
	}

	const provider: MarkedAutocompleteProvider = {
		triggerCharacters: current.triggerCharacters,
		shouldTriggerFileCompletion:
			current.shouldTriggerFileCompletion?.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = await current.getSuggestions(
				lines,
				cursorLine,
				cursorCol,
				options,
			);
			if (
				suggestions &&
				Array.isArray(suggestions.items) &&
				suggestions.items.length > 0
			) {
				return padSuggestions(suggestions);
			}

			reset();
			return suggestions;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix): ApplyResult {
			if (isBlankItem(item)) return { lines, cursorLine, cursorCol };
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},
	};
	provider[PROVIDER_MARK] = true;
	return provider;
}

type StickyState = {
	renderHeight: number;
	activeSource: string | undefined;
};

type AutocompleteRequestOptions = { force: boolean; explicitTab: boolean };

function resetStickyState(state: StickyState): void {
	state.renderHeight = 0;
	state.activeSource = undefined;
}

function installAutocompleteListPatch(
	editor: AnyEditor,
	state: StickyState,
): void {
	const originalCreate = editor.createAutocompleteList?.bind(editor);
	editor.createAutocompleteList = (
		prefix: string,
		items: AutocompleteItem[],
	) => {
		const source = completionSource(prefix);
		if (state.activeSource && state.activeSource !== source)
			resetStickyState(state);
		state.activeSource = source;

		const list = originalCreate
			? originalCreate(prefix, items)
			: new SelectList(
					items,
					editor.getAutocompleteMaxVisible?.() ?? DEFAULT_MAX_VISIBLE,
					editor.theme.selectList,
				);

		const originalRender = list.render.bind(list);
		list.render = (width: number) => {
			const lines = originalRender(width);
			state.renderHeight = Math.max(state.renderHeight, lines.length);
			return padLines(lines, state.renderHeight);
		};

		return list;
	};
}

function isSingleRealSuggestion(
	suggestions: AutocompleteSuggestions,
	options: AutocompleteRequestOptions,
): boolean {
	return (
		options.force &&
		options.explicitTab &&
		suggestions.items.length === 1 &&
		!isBlankItem(suggestions.items[0])
	);
}

function applySingleSuggestion(
	editor: AnyEditor,
	provider: AutocompleteProvider,
	suggestions: AutocompleteSuggestions,
	tui: TUI,
): void {
	const item = suggestions.items[0]!;
	editor.pushUndoSnapshot?.();
	editor.lastAction = null;
	const result = provider.applyCompletion(
		editor.state.lines,
		editor.state.cursorLine,
		editor.state.cursorCol,
		item,
		suggestions.prefix,
	);
	editor.state.lines = result.lines;
	editor.state.cursorLine = result.cursorLine;
	editor.setCursorCol?.(result.cursorCol);
	if (editor.onChange) editor.onChange(editor.getText());
	tui.requestRender();
}

function installAutocompleteRequestPatch(editor: AnyEditor, tui: TUI): void {
	editor.runAutocompleteRequest = async (
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: AutocompleteRequestOptions,
	) => {
		const provider = editor.autocompleteProvider;
		if (!provider) return;

		const suggestions = await provider.getSuggestions(
			editor.state.lines,
			editor.state.cursorLine,
			editor.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);

		const current = editor.isAutocompleteRequestCurrent?.(
			requestId,
			controller,
			snapshotText,
			snapshotLine,
			snapshotCol,
		);
		if (!current) return;

		editor.autocompleteAbort = undefined;

		if (
			!suggestions ||
			!Array.isArray(suggestions.items) ||
			suggestions.items.length === 0
		) {
			editor.cancelAutocomplete?.();
			tui.requestRender();
			return;
		}

		if (isSingleRealSuggestion(suggestions, options)) {
			applySingleSuggestion(editor, provider, suggestions, tui);
			return;
		}

		editor.applyAutocompleteSuggestions?.(
			suggestions,
			options.force ? "force" : "regular",
		);
		tui.requestRender();
	};
}

function installInputPatch(editor: AnyEditor): void {
	const originalHandleInput = editor.handleInput?.bind(editor);
	editor.handleInput = (data: string) => {
		const kb = getKeybindings();
		if (editor.autocompleteState && editor.autocompleteList) {
			const selected = editor.autocompleteList.getSelectedItem?.();
			if (
				isBlankItem(selected) &&
				(kb.matches(data, "tui.select.confirm") ||
					kb.matches(data, "tui.input.tab"))
			)
				return;
		}
		originalHandleInput?.(data);
	};
}

function installCleanupPatch(editor: AnyEditor, state: StickyState): void {
	const originalCancel = editor.cancelAutocomplete?.bind(editor);
	const originalClear = editor.clearAutocompleteUi?.bind(editor);
	editor.clearAutocompleteUi = () => {
		resetStickyState(state);
		originalClear?.();
	};
	editor.cancelAutocomplete = () => {
		resetStickyState(state);
		originalCancel?.();
	};
}

function patchStableCompletion(editor: AnyEditor, tui: TUI): AnyEditor {
	if (editor[EDITOR_MARK]) return editor;
	editor[EDITOR_MARK] = true;
	const state: StickyState = { renderHeight: 0, activeSource: undefined };
	installAutocompleteListPatch(editor, state);
	installAutocompleteRequestPatch(editor, tui);
	installInputPatch(editor);
	installCleanupPatch(editor, state);
	return editor;
}

export default function (pi: ExtensionAPI) {
	patchSelectListBlankRows();

	let baseFactory: CompletionEditorFactory | undefined;
	let installedFactory: CompletionEditorFactory | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.addAutocompleteProvider(stableSuggestionsProvider);

		const previousFactory = ctx.ui.getEditorComponent() as
			| CompletionEditorFactory
			| undefined;
		baseFactory = previousFactory?.[EDITOR_FACTORY_MARK]
			? previousFactory[EDITOR_FACTORY_BASE]
			: previousFactory;

		const nextFactory: CompletionEditorFactory = (
			tui: TUI,
			theme: EditorTheme,
			keybindings: KeybindingsManager,
		) => {
			const editor = baseFactory
				? baseFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			return patchStableCompletion(editor as AnyEditor, tui);
		};
		nextFactory[EDITOR_FACTORY_MARK] = true;
		nextFactory[EDITOR_FACTORY_BASE] = baseFactory;
		installedFactory = nextFactory;
		ctx.ui.setEditorComponent(nextFactory);

		ctx.ui.setStatus("pi-completion", "sticky completion");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus("pi-completion", undefined);
		if (ctx.ui.getEditorComponent() === installedFactory) {
			ctx.ui.setEditorComponent(baseFactory);
		}
		installedFactory = undefined;
		baseFactory = undefined;
	});
}
