import { readSettings } from "./config";

export function previewLimit(): number {
	const value = readSettings().previewLines;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 8;
}

export function expandedPreviewLimit(): number {
	const settings = readSettings();
	const value = settings["expandedPreviewMaxLines"];
	const fallback = 4000;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function bashCollapsedLimit(): number {
	const value = readSettings().bashCollapsedLines;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 10;
}

export function liveToolPreviewEnabled(): boolean {
	return readSettings().liveToolPreview !== false;
}

export function liveToolPreviewLimit(): number {
	const value = readSettings().liveToolPreviewLines;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 5;
}

export function diffCollapsedLimit(): number {
	const value = readSettings().diffCollapsedLines;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 24;
}

export function collapsedPreviewCount(expanded: boolean, fallback: number): number {
	return expanded ? expandedPreviewLimit() : fallback;
}
