import { countDiffHunks, parseDiff } from "./parse";
import type { EditOperation, ParsedDiff } from "./types";

export interface EditOperationSummary {
	diffs: ParsedDiff[];
	totalAdded: number;
	totalRemoved: number;
	totalLines: number;
	totalHunks: number;
	summary: string;
}

function defaultSummaryFormatter(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) parts.push(`+${added}`);
	if (removed > 0) parts.push(`-${removed}`);
	return parts.length ? parts.join(" ") : "no changes";
}

export function getEditOperations(input: any): EditOperation[] {
	if (Array.isArray(input?.edits)) {
		return input.edits
			.map((edit: any) => ({
				oldText: typeof edit?.oldText === "string" ? edit.oldText : typeof edit?.old_text === "string" ? edit.old_text : "",
				newText: typeof edit?.newText === "string" ? edit.newText : typeof edit?.new_text === "string" ? edit.new_text : "",
			}))
			.filter((edit: EditOperation) => edit.oldText && edit.oldText !== edit.newText);
	}
	const oldText = typeof input?.oldText === "string" ? input.oldText : typeof input?.old_text === "string" ? input.old_text : "";
	const newText = typeof input?.newText === "string" ? input.newText : typeof input?.new_text === "string" ? input.new_text : "";
	return oldText && oldText !== newText ? [{ oldText, newText }] : [];
}

export function summarizeEditOperations(
	operations: EditOperation[],
	formatSummary: (added: number, removed: number) => string = defaultSummaryFormatter,
): EditOperationSummary {
	const diffs = operations.map((edit) => parseDiff(edit.oldText, edit.newText));
	const totalAdded = diffs.reduce((sum, diff) => sum + diff.added, 0);
	const totalRemoved = diffs.reduce((sum, diff) => sum + diff.removed, 0);
	const totalLines = diffs.reduce((sum, diff) => sum + diff.lines.length, 0);
	const totalHunks = diffs.reduce((sum, diff) => sum + countDiffHunks(diff), 0);
	return { diffs, totalAdded, totalRemoved, totalLines, totalHunks, summary: formatSummary(totalAdded, totalRemoved) };
}

export function getCachedEditOperationSummary(
	ctx: any,
	key: string,
	operations: EditOperation[],
	formatSummary: (added: number, removed: number) => string = defaultSummaryFormatter,
): EditOperationSummary {
	if (ctx.state?._editSummaryKey === key && ctx.state._editSummary) {
		return ctx.state._editSummary as EditOperationSummary;
	}
	const summary = summarizeEditOperations(operations, formatSummary);
	if (ctx.state) {
		ctx.state._editSummaryKey = key;
		ctx.state._editSummary = summary;
	}
	return summary;
}
