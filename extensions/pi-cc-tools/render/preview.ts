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

export function previewTruncationSuffix(totalLines: number, shownLines: number, expanded: boolean, theme: Theme, maxLines: number, tail = false): string {
	const remaining = totalLines - shownLines;
	let text = "";
	if (remaining > 0) {
		const label = tail ? "earlier lines" : "more lines";
		text += `\n${theme.fg("muted", `... (${remaining} ${label}${toolOutputDetailHint(theme, expanded, true)})`)}`;
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
	options: { tail?: boolean } = {},
): string {
	if (lines.length === 0) return theme.fg("muted", "(no output)");
	const maxLines = collapsedPreviewCount(expanded, fallbackCollapsed);
	const shownRaw = options.tail ? lines.slice(-maxLines) : lines.slice(0, maxLines);
	const shown = shownRaw.map(mapLine);
	const suffix = previewTruncationSuffix(lines.length, shown.length, expanded, theme, maxLines, options.tail);
	return options.tail && lines.length > shown.length ? `${suffix.slice(1)}\n${shown.join("\n")}` : shown.join("\n") + suffix;
}
