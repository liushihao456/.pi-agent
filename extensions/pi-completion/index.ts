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
	type Component,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const BLANK_VALUE_PREFIX = "__pi_completion_blank__";
const DEFAULT_MAX_VISIBLE = 5;
const PATCH_MARK = Symbol.for("pi-completion.select-list-render-v2-patched");

type ApplyResult = { lines: string[]; cursorLine: number; cursorCol: number };

type AnyEditor = Component & {
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
	if (prefix.length > 0) return prefix[0] ?? "unknown";
	return "unknown";
}

function padLines(lines: string[], targetHeight: number): string[] {
	if (targetHeight <= lines.length) return lines;
	return [
		...lines,
		...Array.from({ length: targetHeight - lines.length }, () => ""),
	];
}

function patchSelectListBlankRows() {
	const proto = SelectList.prototype as SelectList & {
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

	return {
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
}

function patchStableCompletion(editor: AnyEditor, tui: TUI): AnyEditor {
	const originalCreate = editor.createAutocompleteList?.bind(editor);
	const originalRun = editor.runAutocompleteRequest?.bind(editor);
	const originalHandleInput = editor.handleInput?.bind(editor);
	const originalCancel = editor.cancelAutocomplete?.bind(editor);
	const originalClear = editor.clearAutocompleteUi?.bind(editor);

	let stickyRenderHeight = 0;
	let activeSource: string | undefined;

	const resetSticky = () => {
		stickyRenderHeight = 0;
		activeSource = undefined;
	};

	editor.createAutocompleteList = (
		prefix: string,
		items: AutocompleteItem[],
	) => {
		const source = completionSource(prefix);
		if (activeSource && activeSource !== source) resetSticky();
		activeSource = source;

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
			stickyRenderHeight = Math.max(stickyRenderHeight, lines.length);
			return padLines(lines, stickyRenderHeight);
		};

		return list;
	};

	editor.runAutocompleteRequest = async (
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	) => {
		const provider = editor.autocompleteProvider;
		if (!provider) return;

		const suggestions: AutocompleteSuggestions | null =
			await provider.getSuggestions(
				editor.state.lines,
				editor.state.cursorLine,
				editor.state.cursorCol,
				{ signal: controller.signal, force: options.force },
			);

		if (
			!editor.isAutocompleteRequestCurrent?.(
				requestId,
				controller,
				snapshotText,
				snapshotLine,
				snapshotCol,
			)
		)
			return;

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

		if (originalRun) {
			// Base method exists. We intentionally replay logic to avoid second provider call.
		}

		if (
			options.force &&
			options.explicitTab &&
			suggestions.items.length === 1 &&
			!isBlankItem(suggestions.items[0])
		) {
			const item = suggestions.items[0];
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
			return;
		}

		editor.applyAutocompleteSuggestions?.(
			suggestions,
			options.force ? "force" : "regular",
		);
		tui.requestRender();
	};

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

	editor.clearAutocompleteUi = () => {
		resetSticky();
		originalClear?.();
	};

	editor.cancelAutocomplete = () => {
		resetSticky();
		originalCancel?.();
	};

	return editor;
}

export default function (pi: ExtensionAPI) {
	patchSelectListBlankRows();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.addAutocompleteProvider(stableSuggestionsProvider);

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent(
			(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
				const editor = previousFactory
					? previousFactory(tui, theme, keybindings)
					: new CustomEditor(tui, theme, keybindings);
				return patchStableCompletion(editor as AnyEditor, tui) as AnyEditor;
			},
		);

		ctx.ui.setStatus("pi-completion", "sticky completion");
	});
}
