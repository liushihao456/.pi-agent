import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { fitBorder } from "./border.ts";
import { renderZoneContent } from "./render.ts";
import type { PiStatusConfig, RuntimeState } from "./types.ts";

/**
 * PiStatusEditor extends CustomEditor to add zone-based border decorations
 * following the Osdy-Pi border decoration protocol.
 *
 * The editor replaces the original top/bottom editor border lines with
 * status bars, leaving input content lines unwrapped (no side borders).
 *
 * Each zone collects its assigned status modules and renders them
 * into the top or bottom status row using fitBorder().
 */
export class PiStatusEditor extends CustomEditor {
	private readonly piStatusConfig: PiStatusConfig;
	private readonly piStatusState: RuntimeState;
	private readonly piCtx: ExtensionContext;
	private readonly piTheme: Theme;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		config: PiStatusConfig,
		state: RuntimeState,
		ctx: ExtensionContext,
		themeRef: Theme,
	) {
		super(tui, theme, keybindings, { paddingX: 1 });
		this.piStatusConfig = config;
		this.piStatusState = state;
		this.piCtx = ctx;
		this.piTheme = themeRef;
	}

	override render(width: number): string[] {
		if (this.piStatusState.destroyed) return super.render(width);

		// Progressive degradation: too narrow for borders or autocomplete is showing
		if (width < 4 || this.isShowingAutocomplete()) return super.render(width);

		const lines = super.render(width);

		if (lines.length < 2) return lines;

		const bottomIndex = Math.max(1, lines.length - 1);
		const borderColor = (text: string) => this.borderColor(text);

		// Replace top border row with top-left and top-right status content.
		const topLeft = this.renderStyledZoneContent("top-left");
		const topRight = this.renderStyledZoneContent("top-right");
		lines[0] = fitBorder(topLeft, topRight, width, borderColor);

		// Replace bottom border row with bottom-left and bottom-right status content.
		const bottomLeft = this.renderStyledZoneContent("bottom-left");
		const bottomRight = this.renderStyledZoneContent("bottom-right");
		lines[bottomIndex] = fitBorder(bottomLeft, bottomRight, width, borderColor);

		return lines;
	}

	/**
	 * Render zone content with a styled separator prefix.
	 * The prefix adds a space before and after the zone content
	 * so it doesn't sit directly on the border corner.
	 */
	private renderStyledZoneContent(
		zone: "top-left" | "top-right" | "bottom-left" | "bottom-right",
	): string {
		const content = renderZoneContent(
			this.piStatusConfig,
			this.piStatusState,
			this.piCtx,
			this.piTheme,
			zone,
		);
		return content ? ` ${content} ` : "";
	}
}

/**
 * Factory function that creates a PiStatusEditor.
 * This should be passed to ctx.ui.setEditorComponent().
 */
export function createPiStatusEditorFactory(
	config: PiStatusConfig,
	state: RuntimeState,
	ctx: ExtensionContext,
	themeRef: Theme,
	onTui?: (requestRender: () => void) => void,
) {
	return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		onTui?.(() => tui.requestRender());
		return new PiStatusEditor(
			tui,
			theme,
			keybindings,
			config,
			state,
			ctx,
			themeRef,
		);
	};
}
