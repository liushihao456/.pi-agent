// @ts-nocheck
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { BundledLanguage } from "shiki";

import { normalizeToLf } from "../diff/async-service";
import { countDiffHunks, parseDiff } from "../diff/parse";
import {
	branchDiffWidth,
	diffSummaryWithMeta,
	lang,
	MAX_PREVIEW_LINES,
	MAX_RENDER_LINES,
	renderSplit,
	summarizeDiff,
} from "../diff/render";
import type { DiffLine, ParsedDiff } from "../diff/types";
import { withBranch } from "../render/branch";

let deps: any = {};

export function configureApplyPatchRenderer(nextDeps: any): void {
	deps = nextDeps ?? {};
}

export function extractApplyPatchFiles(patchText: string): string[] {
	if (!patchText) return [];
	const files = new Set<string>();
	for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
		const filePath = match[1]?.trim();
		if (filePath) files.add(filePath);
	}
	return [...files];
}

interface ApplyPatchChangePreview {
	kind: "add" | "update" | "delete";
	path: string;
	displayPath: string;
	moveTo?: string;
	diff: ParsedDiff;
	language: BundledLanguage | undefined;
	hunks: number;
	summary: string;
	line: number;
}

interface ApplyPatchPreview {
	changes: ApplyPatchChangePreview[];
	totalAdded: number;
	totalRemoved: number;
	totalHunks: number;
	totalLines: number;
	summary: string;
}

interface ApplyPatchResultMeta {
	changeCount: number;
	totalAdded: number;
	totalRemoved: number;
	totalHunks: number;
	totalLines: number;
	firstChange?: {
		displayPath: string;
		kind: ApplyPatchChangePreview["kind"];
		hunks: number;
		line: number;
		added: number;
		removed: number;
	};
}

function buildApplyPatchResultMeta(preview: ApplyPatchPreview): ApplyPatchResultMeta {
	const firstChange = preview.changes[0];
	return {
		changeCount: preview.changes.length,
		totalAdded: preview.totalAdded,
		totalRemoved: preview.totalRemoved,
		totalHunks: preview.totalHunks,
		totalLines: preview.totalLines,
		firstChange: firstChange
			? {
				displayPath: firstChange.displayPath,
				kind: firstChange.kind,
				hunks: firstChange.hunks,
				line: firstChange.line,
				added: firstChange.diff.added,
				removed: firstChange.diff.removed,
			}
			: undefined,
	};
}

function getApplyPatchLine(diff: ParsedDiff, kind: ApplyPatchChangePreview["kind"]): number {
	if (kind === "add") return diff.lines.find((line) => line.type === "add" && line.newNum !== null)?.newNum ?? 1;
	if (kind === "delete") return diff.lines.find((line) => line.type === "del" && line.oldNum !== null)?.oldNum ?? 1;
	for (const line of diff.lines) {
		if (line.type === "add" && line.newNum !== null) return line.newNum;
		if (line.type === "del" && line.oldNum !== null) return line.oldNum;
	}
	return 0;
}

function parsePatchBodyLine(rawLine: string): { marker: "+" | "-" | " "; content: string } {
	const marker = rawLine[0];
	if (marker === "+" || marker === "-" || marker === " ") return { marker, content: rawLine.slice(1) };
	return { marker: " ", content: rawLine };
}

function findLineSequence(haystack: string[], needle: string[], fromIndex = 0): number {
	if (needle.length === 0) return Math.max(0, fromIndex);
	outer: for (let i = Math.max(0, fromIndex); i <= haystack.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

function inferApplyPatchHunkStarts(lines: string[], sourceContent: string): Array<{ oldStart: number | null; newStart: number | null }> {
	const sourceLines = normalizeToLf(sourceContent).split("\n");
	const hunks: string[][] = [];
	let currentHunk: string[] | null = null;
	for (const rawLine of lines) {
		if (rawLine.startsWith("*** Move to: ")) continue;
		if (rawLine.startsWith("@@")) {
			if (currentHunk) hunks.push(currentHunk);
			currentHunk = [];
			continue;
		}
		if (!currentHunk) currentHunk = [];
		currentHunk.push(rawLine);
	}
	if (currentHunk) hunks.push(currentHunk);

	const starts: Array<{ oldStart: number | null; newStart: number | null }> = [];
	let searchFrom = 0;
	let lineDelta = 0;
	for (const hunk of hunks) {
		const oldLines = hunk.map((rawLine) => parsePatchBodyLine(rawLine)).filter((line) => line.marker !== "+").map((line) => line.content);
		let matchIndex = findLineSequence(sourceLines, oldLines, searchFrom);
		if (matchIndex === -1) matchIndex = findLineSequence(sourceLines, oldLines, 0);
		const oldStart = matchIndex === -1 ? null : matchIndex + 1;
		const newStart = oldStart === null ? null : oldStart + lineDelta;
		starts.push({ oldStart, newStart });
		if (matchIndex === -1) continue;
		searchFrom = matchIndex + oldLines.length;
		const added = hunk.filter((rawLine) => parsePatchBodyLine(rawLine).marker === "+").length;
		const removed = hunk.filter((rawLine) => parsePatchBodyLine(rawLine).marker === "-").length;
		lineDelta += added - removed;
	}
	return starts;
}

function stripPatchLinePrefix(line: string, prefix: "+" | "-"): string {
	return line.startsWith(prefix) ? line.slice(1) : line;
}

function trimDiffSeparators(lines: DiffLine[]): DiffLine[] {
	const trimmed = [...lines];
	while (trimmed[0]?.type === "sep") trimmed.shift();
	while (trimmed[trimmed.length - 1]?.type === "sep") trimmed.pop();
	return trimmed;
}

function parseApplyPatchUpdateDiff(lines: string[], sourceContent?: string): ParsedDiff {
	const diffLines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	let chars = 0;
	let oldLine: number | null = null;
	let newLine: number | null = null;
	let inHunk = false;
	const inferredStarts = sourceContent ? inferApplyPatchHunkStarts(lines, sourceContent) : [];
	let hunkIndex = 0;

	for (const rawLine of lines) {
		if (rawLine.startsWith("*** Move to: ")) continue;
		if (rawLine.startsWith("@@")) {
			if (diffLines.length > 0 && diffLines[diffLines.length - 1]?.type !== "sep") diffLines.push({ type: "sep", oldNum: null, newNum: null, content: "" });
			const match = rawLine.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
			const inferred = inferredStarts[hunkIndex] ?? { oldStart: null, newStart: null };
			oldLine = match ? Number.parseInt(match[1], 10) : inferred.oldStart;
			newLine = match ? Number.parseInt(match[2], 10) : inferred.newStart;
			hunkIndex++;
			inHunk = true;
			continue;
		}
		if (rawLine === "\\ No newline at end of file") continue;
		if (!inHunk) {
			const inferred = inferredStarts[hunkIndex] ?? { oldStart: null, newStart: null };
			oldLine = inferred.oldStart;
			newLine = inferred.newStart;
			hunkIndex++;
			inHunk = true;
		}

		const { marker, content } = parsePatchBodyLine(rawLine);
		chars += content.length;
		if (marker === "+") {
			diffLines.push({ type: "add", oldNum: null, newNum: newLine, content });
			added++;
			if (newLine !== null) newLine++;
			continue;
		}
		if (marker === "-") {
			diffLines.push({ type: "del", oldNum: oldLine, newNum: null, content });
			removed++;
			if (oldLine !== null) oldLine++;
			continue;
		}
		diffLines.push({ type: "ctx", oldNum: oldLine, newNum: newLine, content });
		if (oldLine !== null) oldLine++;
		if (newLine !== null) newLine++;
	}

	return { lines: trimDiffSeparators(diffLines), added, removed, chars };
}

function parseApplyPatchPreview(patchText: string, sp: (path: string) => string, cwd = process.cwd()): ApplyPatchPreview {
	const normalized = patchText.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const changes: ApplyPatchChangePreview[] = [];
	let index = 0;
	const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
	const endHeader = /^\*\*\* End Patch$/;

	while (index < lines.length) {
		const line = lines[index];
		if (!line || line === "*** Begin Patch") { index++; continue; }
		if (endHeader.test(line)) break;
		const header = line.match(fileHeader);
		if (!header) { index++; continue; }
		const kind = header[1].toLowerCase() as ApplyPatchChangePreview["kind"];
		const path = header[2].trim();
		index++;
		let moveTo: string | undefined;
		const body: string[] = [];
		while (index < lines.length && !fileHeader.test(lines[index]) && !endHeader.test(lines[index])) {
			if (lines[index].startsWith("*** Move to: ")) {
				moveTo = lines[index].slice("*** Move to: ".length).trim();
				index++;
				continue;
			}
			body.push(lines[index]);
			index++;
		}

		const displayPath = moveTo ? `${sp(path)} ${deps.BORDER_COLOR}→${deps.TRANSPARENT_RESET} ${sp(moveTo)}` : sp(path);
		let sourceContent: string | undefined;
		if (kind === "update") {
			try { sourceContent = readFileSync(resolve(cwd, path), "utf8"); } catch { sourceContent = undefined; }
		}
		const diff = kind === "add"
			? parseDiff("", body.map((entry) => stripPatchLinePrefix(entry, "+")).join("\n"))
			: kind === "delete"
				? parseDiff(body.map((entry) => stripPatchLinePrefix(entry, "-")).join("\n"), "")
				: parseApplyPatchUpdateDiff(body, sourceContent);
		changes.push({ kind, path, displayPath, moveTo, diff, language: lang(moveTo || path), hunks: countDiffHunks(diff), summary: summarizeDiff(diff.added, diff.removed), line: getApplyPatchLine(diff, kind) });
	}

	const totalAdded = changes.reduce((sum, change) => sum + change.diff.added, 0);
	const totalRemoved = changes.reduce((sum, change) => sum + change.diff.removed, 0);
	const totalHunks = changes.reduce((sum, change) => sum + change.hunks, 0);
	const totalLines = changes.reduce((sum, change) => sum + change.diff.lines.length, 0);
	return { changes, totalAdded, totalRemoved, totalHunks, totalLines, summary: summarizeDiff(totalAdded, totalRemoved) };
}

function describeApplyPatchChange(change: ApplyPatchChangePreview): string {
	if (change.moveTo) return `Rename ${change.displayPath}`;
	if (change.kind === "add") return `Create ${change.displayPath}`;
	if (change.kind === "delete") return `Delete ${change.displayPath}`;
	return `Update ${change.displayPath}`;
}

function formatApplyPatchLine(change: ApplyPatchChangePreview, theme: any): string {
	return deps.formatLineMeta(change.line, theme);
}

function getCachedApplyPatchPreview(patchText: string, sp: (path: string) => string, ctx: any): ApplyPatchPreview | null {
	if (!patchText) return null;
	const key = `apply-meta:${ctx.cwd ?? process.cwd()}:${deps.hashText(patchText)}`;
	if (ctx.state?._applyPatchMetaKey === key && ctx.state._applyPatchPreview) return ctx.state._applyPatchPreview as ApplyPatchPreview;
	try {
		const preview = parseApplyPatchPreview(patchText, sp, ctx.cwd ?? process.cwd());
		if (ctx.state) {
			ctx.state._applyPatchMetaKey = key;
			ctx.state._applyPatchPreview = preview;
			ctx.state._applyPatchMeta = buildApplyPatchResultMeta(preview);
		}
		return preview;
	} catch {
		return null;
	}
}

function getApplyPatchResultMeta(args: any, ctx: any, sp: (path: string) => string): ApplyPatchResultMeta | null {
	const patchText = deps.getStringArg(args ?? ctx?.args, "patchText", "patch_text");
	if (!patchText) return null;
	const preview = getCachedApplyPatchPreview(patchText, sp, ctx);
	return preview && ctx.state?._applyPatchMeta ? (ctx.state._applyPatchMeta as ApplyPatchResultMeta) : null;
}

export function renderApplyPatchCall(args: any, theme: any, ctx: any, sp: (path: string) => string): any {
	deps.syncToolCallStatus(ctx);
	const patchText = deps.getStringArg(args, "patchText", "patch_text");
	const summary = deps.stableCallSummary(ctx, "_callSummary", () => deps.summarizeOpenAiToolCall("apply_patch", args, theme, sp));
	const hdr = deps.toolHeader("Apply Patch", summary, theme, deps.toolStatusDot(ctx, theme));

	if (!ctx.argsComplete) return deps.makeText(ctx.lastComponent, hdr);
	const preview = getCachedApplyPatchPreview(patchText, sp, ctx);
	if (!preview || preview.changes.length === 0) {
		ctx.state._openAiPatchFiles = [];
		return deps.makeText(ctx.lastComponent, hdr);
	}
	ctx.state._openAiPatchFiles = preview.changes.map((change) => change.displayPath);

	const diffWidth = branchDiffWidth();
	const key = `apply-preview:${ctx.state._applyPatchMetaKey ?? deps.hashText(patchText)}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
	if (ctx.state._applyPatchPreviewKey !== key) {
		ctx.state._applyPatchPreviewKey = key;
		ctx.state._applyPatchPreviewBody = theme.fg("muted", "(rendering…)");
		ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
		const dc = deps.resolveDiffColors(theme);
		if (preview.changes.length === 1) {
			const [change] = preview.changes;
			renderSplit(change.diff, change.language, ctx.expanded ? MAX_PREVIEW_LINES : 32, dc, diffWidth)
				.then((rendered) => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					ctx.state._applyPatchPreviewBody = `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}\n${rendered}`;
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					deps.safeInvalidate(ctx);
				})
				.catch(() => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					ctx.state._applyPatchPreviewBody = `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}`;
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					deps.safeInvalidate(ctx);
				});
		} else {
			const maxShown = ctx.expanded ? preview.changes.length : Math.min(preview.changes.length, 3);
			const previewLines = ctx.expanded ? Math.max(6, Math.floor(MAX_RENDER_LINES / Math.max(1, maxShown))) : Math.max(8, Math.floor(MAX_PREVIEW_LINES / Math.max(1, maxShown)));
			Promise.all(preview.changes.slice(0, maxShown).map((change, index) =>
				renderSplit(change.diff, change.language, previewLines, dc, diffWidth)
					.then((rendered) => `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}\n${rendered}`)
					.catch(() => `${index + 1}. ${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}`),
			))
				.then((sections) => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					const remainder = preview.changes.length - maxShown;
					const suffix = remainder > 0 ? `\n${theme.fg("muted", `… ${remainder} more file patches${deps.toolOutputDetailHint(theme, ctx.expanded, true)}`)}` : "";
					const summary = `${preview.changes.length} files ${preview.summary}`;
					ctx.state._applyPatchPreviewBody = `${summary}\n\n${sections.join("\n\n")}${suffix}`;
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					deps.safeInvalidate(ctx);
				})
				.catch(() => {
					if (ctx.state._applyPatchPreviewKey !== key) return;
					ctx.state._applyPatchPreviewBody = `${preview.changes.length} files ${preview.summary}`;
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true);
					deps.safeInvalidate(ctx);
				});
		}
	}

	const body = ctx.state._applyPatchPreviewDisplay as string | undefined;
	return deps.makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
}

export function renderApplyPatchResult(result: any, isPartial: boolean, theme: any, ctx: any): any {
	if (isPartial) return deps.makeText(ctx.lastComponent, deps.runningPreviewBlock(result, theme.fg("dim", "Applying Patch..."), !!ctx?.expanded, theme, ctx));
	deps.clearBlinkTimer(ctx);
	deps.setToolStatus(ctx, ctx.isError ? "error" : "success");

	if (ctx.isError) {
		const raw = deps.getTextContent(result).trim();
		const firstLine = raw ? raw.split("\n")[0] : "Apply patch failed";
		return deps.makeText(ctx.lastComponent, withBranch(theme.fg("error", firstLine), theme));
	}

	const meta = getApplyPatchResultMeta(ctx.args, ctx, (path: string) => deps.shortPath(ctx.cwd ?? process.cwd(), path));
	if (!meta || meta.changeCount === 0) return deps.makeText(ctx.lastComponent, withBranch(theme.fg("success", "Applied"), theme));

	if (meta.changeCount === 1 && meta.firstChange) {
		const change = meta.firstChange;
		const summary = diffSummaryWithMeta(change.added, change.removed, change.hunks, change.kind === "add" ? "new file" : change.kind === "delete" ? "delete" : "");
		return deps.makeText(ctx.lastComponent, withBranch(`${theme.fg("success", "Applied")} ${theme.fg("muted", change.displayPath)} ${summary}${deps.formatLineMeta(change.line, theme)}`, theme));
	}

	const summary = diffSummaryWithMeta(meta.totalAdded, meta.totalRemoved, meta.totalHunks, "");
	return deps.makeText(ctx.lastComponent, withBranch(`${theme.fg("success", "Applied")} ${meta.changeCount} files ${summary}${meta.totalLines ? ` ${theme.fg("muted", `(${meta.totalLines} diff lines)`)}` : ""}`, theme));
}
