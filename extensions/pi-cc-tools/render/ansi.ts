import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function padRenderedLineToWidth(line: string, width: number): string {
	if (width <= 0) return "";
	const gap = width - visibleWidth(line);
	if (gap <= 0) return line;
	return line + " ".repeat(gap);
}

export function isBlankLine(text: string): boolean {
	return stripAnsi(text).trim().length === 0;
}

export function clampLineWidth(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function padToWidth(line: string, width: number): string {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const clipped = clampLineWidth(line, safeWidth);
	const padding = Math.max(0, safeWidth - visibleWidth(clipped));
	return `${clipped}${" ".repeat(padding)}`;
}
