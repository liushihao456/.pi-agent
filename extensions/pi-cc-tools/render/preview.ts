import type { Theme } from "@earendil-works/pi-coding-agent";

type CollapsedPreviewCount = (expanded: boolean, fallback: number) => number;
type ToolOutputDetailHint = (theme: Theme, expanded: boolean, hasMore: boolean) => string;

let collapsedPreviewCount: CollapsedPreviewCount = (_expanded, fallback) => fallback;
let toolOutputDetailHint: ToolOutputDetailHint = () => "";

export function configurePreviewRenderer(options: {
	collapsedPreviewCount?: CollapsedPreviewCount;
	toolOutputDetailHint?: ToolOutputDetailHint;
}): void {
	if (options.collapsedPreviewCount) collapsedPreviewCount = options.collapsedPreviewCount;
	if (options.toolOutputDetailHint) toolOutputDetailHint = options.toolOutputDetailHint;
}

export function buildPreviewText(lines: string[], expanded: boolean, theme: Theme, fallbackCollapsed = 8): string {
	return buildPreviewTextMapped(lines, expanded, theme, fallbackCollapsed, (line) => line);
}

export function previewTruncationSuffix(totalLines: number, shownLines: number, expanded: boolean, theme: Theme, maxLines: number): string {
	const remaining = totalLines - shownLines;
	let text = "";
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more lines${toolOutputDetailHint(theme, expanded, true)})`)}`;
	}
	if (expanded && totalLines > maxLines) {
		text += `\n${theme.fg("warning", `(display capped at ${maxLines} lines)`)}`;
	}
	return text;
}

export function buildPreviewTextMapped(
	lines: string[],
	expanded: boolean,
	theme: Theme,
	fallbackCollapsed = 8,
	mapLine: (line: string) => string,
): string {
	if (lines.length === 0) return theme.fg("muted", "(no output)");
	const maxLines = collapsedPreviewCount(expanded, fallbackCollapsed);
	const shown = lines.slice(0, maxLines).map(mapLine);
	return shown.join("\n") + previewTruncationSuffix(lines.length, shown.length, expanded, theme, maxLines);
}
