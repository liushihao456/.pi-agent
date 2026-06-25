import * as Diff from "diff";

import type { DiffLine, ParsedDiff } from "./types";

export function parseDiff(oldContent: string, newContent: string, ctxLines = 3): ParsedDiff {
	const patch = Diff.structuredPatch("", "", oldContent, newContent, "", "", { context: ctxLines });
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (let hi = 0; hi < patch.hunks.length; hi++) {
		if (hi > 0) {
			const prev = patch.hunks[hi - 1];
			const gap = patch.hunks[hi].oldStart - (prev.oldStart + prev.oldLines);
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
		}
		const hunk = patch.hunks[hi];
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const raw of hunk.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const ch = raw[0];
			const text = raw.slice(1);
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: newLine++, content: text });
				added++;
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oldLine++, newNum: null, content: text });
				removed++;
			} else {
				lines.push({ type: "ctx", oldNum: oldLine++, newNum: newLine++, content: text });
			}
		}
	}
	return { lines, added, removed, chars: oldContent.length + newContent.length };
}

export function getCachedParsedDiff(ctx: any, key: string, oldContent: string, newContent: string): ParsedDiff {
	if (ctx.state?._parsedDiffKey === key && ctx.state._parsedDiff) {
		return ctx.state._parsedDiff as ParsedDiff;
	}
	const diff = parseDiff(oldContent, newContent);
	if (ctx.state) {
		ctx.state._parsedDiffKey = key;
		ctx.state._parsedDiff = diff;
	}
	return diff;
}

export function offsetParsedDiff(diff: ParsedDiff, oldOffset: number, newOffset = oldOffset): ParsedDiff {
	return {
		...diff,
		lines: diff.lines.map((line) =>
			line.type === "sep"
				? line
				: {
					...line,
					oldNum: line.oldNum === null ? null : line.oldNum + oldOffset,
					newNum: line.newNum === null ? null : line.newNum + newOffset,
				},
		),
	};
}

export function getFirstChangedNewLine(diff: ParsedDiff): number {
	let currentNewLine = 0;
	for (let i = 0; i < diff.lines.length; i++) {
		const line = diff.lines[i];
		if (line.type === "sep") {
			currentNewLine = 0;
			continue;
		}
		if (line.type === "ctx") {
			currentNewLine = (line.newNum ?? currentNewLine) + 1;
			continue;
		}
		if (line.type === "add") return line.newNum ?? currentNewLine;
		if (currentNewLine > 0) return currentNewLine;
		const next = diff.lines.slice(i + 1).find((entry) => entry.type !== "sep" && entry.newNum !== null);
		if (next && next.newNum !== null) return next.newNum;
		return line.oldNum ?? 0;
	}
	return 0;
}

export function countDiffHunks(diff: ParsedDiff): number {
	return diff.lines.length === 0 ? 0 : diff.lines.filter((line) => line.type === "sep").length + 1;
}
