import { createEditTool } from "@earendil-works/pi-coding-agent";

import { shouldDeferLargeEditDiff } from "../diff/async-service";
import { countDiffHunks, getFirstChangedNewLine } from "../diff/parse";
import { getEditOperations } from "../diff/summary";
import {
	branchDiffWidth,
	diffSummaryWithMeta,
	lang,
	MAX_PREVIEW_LINES,
	MAX_RENDER_LINES,
	renderSplit,
	summarizeDiff,
} from "../diff/render";
import type { EditDiffData, ParsedDiff } from "../diff/types";
import { indentBranchBlock, withBranch } from "../render/branch";
import { scheduleKeyedAsyncPreviewRender } from "../render/scheduler";

function renderEditPreviewBody(
	deps: any,
	ctx: any,
	key: string,
	theme: any,
	language: any,
	operations: Array<{ oldText: string; newText: string }>,
	diffs: ParsedDiff[],
	lines: number[],
	summary: string,
): void {
	const { formatLineMeta, resolveDiffColors, safeInvalidate, toolOutputDetailHint } = deps;
	const commitDisplay = (body: string): void => {
		if (ctx.state._pk !== key) return;
		ctx.state._ptBody = body;
		ctx.state._ptDisplay = indentBranchBlock(withBranch(body, theme, false, true));
		ctx.state._ptDisplayKey = key;
		safeInvalidate(ctx);
	};
	const dc = resolveDiffColors(theme);
	const branchWidth = branchDiffWidth();
	if (operations.length === 1) {
		const [diff] = diffs;
		const line = lines[0] ?? getFirstChangedNewLine(diff);
		scheduleKeyedAsyncPreviewRender({
			state: ctx.state,
			key,
			pendingKey: "_ptPendingKey",
			displayKey: "_ptDisplayKey",
			isCurrent: () => ctx.state?._pk === key,
			yieldBeforeRender: true,
			render: () => renderSplit(diff, language, ctx.expanded ? MAX_PREVIEW_LINES : 32, dc, branchWidth)
				.catch(() => `${summarizeDiff(diff.added, diff.removed)}${formatLineMeta(line, theme)}`),
			commit: commitDisplay,
		});
		return;
	}
	const maxShown = ctx.expanded ? operations.length : Math.min(operations.length, 3);
	const previewLines = ctx.expanded
		? Math.max(6, Math.floor(MAX_RENDER_LINES / Math.max(1, maxShown)))
		: Math.max(8, Math.floor(MAX_PREVIEW_LINES / Math.max(1, maxShown)));
	scheduleKeyedAsyncPreviewRender({
		state: ctx.state,
		key,
		pendingKey: "_ptPendingKey",
		displayKey: "_ptDisplayKey",
		isCurrent: () => ctx.state?._pk === key,
		render: () => Promise.all(
			diffs.slice(0, maxShown).map((diff, index) => {
				const line = lines[index] ?? getFirstChangedNewLine(diff);
				return renderSplit(diff, language, previewLines, dc, branchWidth)
					.then((rendered) => `Edit ${index + 1}/${operations.length}${formatLineMeta(line, theme)}\n${rendered}`)
					.catch(() => `Edit ${index + 1}/${operations.length}${formatLineMeta(line, theme)} ${summarizeDiff(diff.added, diff.removed)}`);
			}),
		).then((sections) => {
			const remainder = operations.length - maxShown;
			const suffix = remainder > 0
				? `\n${theme.fg("muted", `… ${remainder} more edit blocks${toolOutputDetailHint(theme, ctx.expanded, true)}`)}`
				: "";
			return `${sections.join("\n\n")}${suffix}`;
		}).catch(() => `${operations.length} edits ${summary}`),
		commit: commitDisplay,
	});
}

export function registerEditTool(deps: any): void {
	const {
		pi,
		cwd,
		asyncDiff,
		clearBlinkTimer,
		formatLineMeta,
		hashText,
		hasOwnArg,
		liveBranchDisplay,
		makeText,
		runningPreviewBlock,
		safeInvalidate,
		setToolStatus,
		shouldRevealCallArgs,
		sp,
		stableCallSummary,
		syncToolCallStatus,
		toolHeader,
		toolPathArg,
		toolStatusDot,
	} = deps;

	const editTool = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: editTool.description,
		parameters: editTool.parameters,
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, _ctx: any) {
			const fp = toolPathArg(params);
			const editParams = fp && params.path !== fp ? { ...(params as any), path: fp } : params;
			const operations = getEditOperations(editParams);
			let editDiffData: EditDiffData | null = null;
			if (operations.length > 0) {
				try {
					const editHash = hashText(operations.map((edit) => `${edit.oldText}\u0000${edit.newText}`).join("\u0001"));
					editDiffData = await asyncDiff.compute(
						{ kind: "edit-diff", key: `edit-execute:${fp}:${editHash}`, filePath: fp, cwd, operations },
						`edit-execute:${toolCallId}`,
					) as EditDiffData;
				} catch {
					editDiffData = null;
				}
			}
			const result = await editTool.execute(toolCallId, editParams, signal, onUpdate);
			if (operations.length === 0 || !editDiffData) return result;
			const diffs = editDiffData.diffs;
			const summary = summarizeDiff(editDiffData.totalAdded, editDiffData.totalRemoved);
			const totalLines = editDiffData.totalLines;
			const totalHunks = editDiffData.totalHunks;
			const localizedDiffs = editDiffData.localizedDiffs;
			const baseDetails = (((result as any).details ?? {}) as Record<string, unknown>);
			if (operations.length === 1) {
				const localized = localizedDiffs?.[0];
				const editLine = localized?.line ?? (typeof baseDetails.firstChangedLine === "number" ? baseDetails.firstChangedLine : 0);
				const diff = localized?.diff ?? diffs[0];
				(result as any).details = {
					...baseDetails,
					_type: "editInfo",
					summary,
					editLine,
					hunks: countDiffHunks(diff),
					added: diff?.added ?? 0,
					removed: diff?.removed ?? 0,
				};
				return result;
			}
			(result as any).details = {
				...baseDetails,
				_type: "multiEditInfo",
				summary,
				editCount: operations.length,
				diffLineCount: totalLines,
				hunks: totalHunks,
				totalAdded: diffs.reduce((sum, diff) => sum + diff.added, 0),
				totalRemoved: diffs.reduce((sum, diff) => sum + diff.removed, 0),
			};
			return result;
		},
		renderCall(args: any, theme: any, ctx: any) {
			const fp = toolPathArg(args);
			const operations = getEditOperations(args);
			const revealSummary = !!fp && (shouldRevealCallArgs(ctx) || hasOwnArg(args, "edits"));
			const summary = stableCallSummary(ctx, "_callSummary", () => shouldRevealCallArgs(ctx) && operations.length > 1 ? `${sp(fp)} ${theme.fg("muted", `(${operations.length} edits)`)}` : sp(fp), revealSummary);
			syncToolCallStatus(ctx);
			const hdr = toolHeader("Edit", summary, theme, ` ${toolStatusDot(ctx, theme)}`);
			// Historical session replay may not call setArgsComplete() before rendering.
			// If edit operations are present, args are complete enough to render preview.
			if (operations.length === 0) return makeText(ctx.lastComponent, hdr);
			const diffWidth = branchDiffWidth();
			const editHash = hashText(operations.map((edit) => `${edit.oldText}\u0000${edit.newText}`).join("\u0001"));
			const parseKey = `edit:${fp}:${editHash}`;
			const renderKey = `${parseKey}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
			if (shouldDeferLargeEditDiff(ctx, parseKey, operations)) {
				const body = liveBranchDisplay(ctx.state, theme) ?? (ctx.state?._ptDisplay as string | undefined);
				return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
			}
			const diffResult = asyncDiff.get(parseKey) as EditDiffData | undefined;
			if (!diffResult) {
				if (ctx.state) ctx.state._pk = renderKey;
				const diffError = asyncDiff.getError(parseKey);
				if (diffError) {
					const body = liveBranchDisplay(ctx.state, theme) ?? (ctx.state?._ptDisplay as string | undefined);
					const err = indentBranchBlock(withBranch(theme.fg("warning", `diff preview: ${diffError}`), theme, false, true));
					return makeText(ctx.lastComponent, body ? `${hdr}\n${body}\n${err}` : `${hdr}\n${err}`);
				}
				asyncDiff.requestLatest(
					{ kind: "edit-diff", key: parseKey, filePath: fp, cwd, operations },
					{
						channel: `edit:${typeof ctx?.toolCallId === "string" ? ctx.toolCallId : fp}`,
						onComplete: () => {
							if (ctx.state?._pk === renderKey) safeInvalidate(ctx);
						},
					},
				);
				const body = liveBranchDisplay(ctx.state, theme) ?? (ctx.state?._ptDisplay as string | undefined);
				return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
			}
			const fallbackDiffs = diffResult.diffs;
			const editSummary = summarizeDiff(diffResult.totalAdded, diffResult.totalRemoved);
			const localizedDiffs = diffResult.localizedDiffs;
			if (ctx.state._pk !== renderKey) {
				ctx.state._pk = renderKey;
				// Keep existing diff visible while new async preview renders. Only show
				// placeholder on first render; do not blank output on every invalidate.
				if (!ctx.state._ptDisplay) {
					ctx.state._ptBody = theme.fg("muted", "(rendering…)");
					ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true));
				}
			}
			if (ctx.state._ptDisplayKey !== renderKey && ctx.state._ptPendingKey !== renderKey) {
				const lg = lang(fp);
				const diffs = localizedDiffs?.map((entry) => entry.diff) ?? fallbackDiffs;
				const lines = localizedDiffs?.map((entry) => entry.line) ?? diffs.map((diff: ParsedDiff) => getFirstChangedNewLine(diff));
				renderEditPreviewBody(deps, ctx, renderKey, theme, lg, operations, diffs, lines, editSummary);
			}
			const body = liveBranchDisplay(ctx.state, theme) ?? (ctx.state._ptDisplay as string | undefined);
			return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
			if (isPartial) {
				return makeText(ctx.lastComponent, indentBranchBlock(runningPreviewBlock(result, theme.fg("dim", "Editing..."), expanded, theme, ctx)));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(theme.fg("error", e), theme)));
			}
			if ((result as any).details?._type === "editInfo") {
				const { editLine, hunks, added, removed } = (result as any).details;
				const loc = formatLineMeta(editLine ?? 0, theme);
				const summary = diffSummaryWithMeta(added ?? 0, removed ?? 0, hunks ?? 0, "");
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(`${summary}${loc}`, theme)));
			}
			if ((result as any).details?._type === "multiEditInfo") {
				const { editCount, diffLineCount, hunks, totalAdded, totalRemoved } = (result as any).details;
				const summary = diffSummaryWithMeta(totalAdded ?? 0, totalRemoved ?? 0, hunks ?? 0, "");
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(`${editCount} edits ${summary}${typeof diffLineCount === "number" ? ` ${theme.fg("muted", `(${diffLineCount} diff lines)`)}` : ""}`, theme)));
			}
			return makeText(ctx.lastComponent, indentBranchBlock(withBranch(theme.fg("success", "Applied"), theme)));
		},
	});
}
