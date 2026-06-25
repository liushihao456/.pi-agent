import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createWriteTool } from "@earendil-works/pi-coding-agent";

import { shouldDeferLargeWriteDiff } from "../diff/async-service";
import { getCachedParsedDiff } from "../diff/parse";
import {
	branchDiffWidth,
	diffSummaryWithMeta,
	lang,
	MAX_RENDER_LINES,
	renderSplit,
	renderUnified,
	shouldUseSplit,
	summarizeDiff,
} from "../diff/render";
import type { ParsedDiff, WriteDiffData } from "../diff/types";
import { indentBranchBlock, withBranch, withFinalBranchBlock } from "../render/branch";
import { scheduleKeyedAsyncPreviewRender } from "../render/scheduler";

const WRITE_EXISTED_BEFORE = new Map<string, boolean>();
const WRITE_OLD_CONTENT = new Map<string, string | null>();

export function registerWriteTool(deps: any): void {
	const {
		pi,
		cwd,
		asyncDiff,
		clearBlinkTimer,
		diffCollapsedLimit,
		fileExistsForTool,
		hashText,
		lineCount,
		makeText,
		resolveDiffColors,
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

	const getWriteWasNewFile = (ctx: any, filePath: string, reveal = shouldRevealCallArgs(ctx)): boolean | undefined => {
		if (typeof ctx?.state?._writeWasNewFile === "boolean") return ctx.state._writeWasNewFile;
		if (!filePath || !reveal) return undefined;
		const existedBefore = typeof ctx?.toolCallId === "string" ? WRITE_EXISTED_BEFORE.get(ctx.toolCallId) : undefined;
		const wasNew = existedBefore === undefined ? !fileExistsForTool(cwd, filePath) : !existedBefore;
		if (ctx?.state) ctx.state._writeWasNewFile = wasNew;
		return wasNew;
	};

	const writeTool = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: writeTool.description,
		parameters: writeTool.parameters,
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, _ctx: any) {
			const fp = toolPathArg(params);
			const writeParams = fp && params.path !== fp ? { ...(params as any), path: fp } : params;
			const fullPath = fp ? resolve(cwd, fp) : "";
			const existedBefore = !!fullPath && fileExistsForTool(cwd, fp);
			WRITE_EXISTED_BEFORE.set(toolCallId, existedBefore);
			let old: string | null = null;
			try {
				if (fullPath && existedBefore) old = readFileSync(fullPath, "utf-8");
			} catch {
				old = null;
			}
			WRITE_OLD_CONTENT.set(toolCallId, old);
			const result = await writeTool.execute(toolCallId, writeParams, signal, onUpdate);
			const content = writeParams.content ?? "";
			if (old !== null && old !== content) {
				try {
					const oldHash = hashText(old);
					const contentHash = hashText(content);
					const diffData = await asyncDiff.compute(
						{ kind: "write-diff", key: `write-execute:${fp}:${oldHash}:${contentHash}`, oldText: old, newText: content },
						`write-execute:${toolCallId}`,
					) as WriteDiffData;
					const diff = diffData.diff;
					(result as any).details = { _type: "diff", summary: summarizeDiff(diff.added, diff.removed), diff, language: lang(fp) };
				} catch {
					// Async diff path: leave core result untouched if diff computation is unavailable.
				}
			} else if (old === null) {
				(result as any).details = { _type: "new", lines: lineCount(content), filePath: fp };
			} else if (old === content) {
				(result as any).details = { _type: "noChange" };
			}
			return result;
		},
		renderCall(args: any, theme: any, ctx: any) {
			const fp = toolPathArg(args);
			const content = typeof args?.content === "string" ? args.content : undefined;
			const revealSummary = shouldRevealCallArgs(ctx) || content !== undefined;
			syncToolCallStatus(ctx);
			const wasNew = getWriteWasNewFile(ctx, fp, revealSummary);
			const label = wasNew === true ? "Create" : "Write";
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				const base = sp(fp);
				if (content === undefined) return base;
				const count = theme.fg("muted", `(${lineCount(content)} lines)`);
				return base ? `${base} ${count}` : count;
			}, revealSummary);
			const hdr = toolHeader(label, summary, theme, toolStatusDot(ctx, theme));
			if (content === undefined) return makeText(ctx.lastComponent, hdr);

			let oldContent: string | null | undefined;
			const toolCallId = typeof ctx?.toolCallId === "string" ? ctx.toolCallId : undefined;
			if (toolCallId && WRITE_OLD_CONTENT.has(toolCallId)) oldContent = WRITE_OLD_CONTENT.get(toolCallId) ?? null;
			if (oldContent === undefined) {
				try {
					oldContent = fileExistsForTool(cwd, fp) ? readFileSync(resolve(cwd, fp), "utf-8") : null;
				} catch {
					oldContent = null;
				}
			}
			const previousContent = oldContent ?? null;
			const oldHash = previousContent === null ? "new" : hashText(previousContent);
			const contentHash = hashText(content);
			const diffWidth = branchDiffWidth();
			const parseKey = `write:${fp}:${oldHash}:${contentHash}`;
			const key = `${parseKey}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
			if (ctx.state) ctx.state._writePreviewActiveKey = key;
			if (previousContent === content) {
				const noChange = indentBranchBlock(withBranch(theme.fg("muted", "✓ no changes"), theme, false, true));
				if (ctx.state) {
					ctx.state._writePreviewKey = key;
					ctx.state._writePreviewDisplay = noChange;
					ctx.state._writePreviewDisplayKey = key;
				}
				return makeText(ctx.lastComponent, `${hdr}\n${noChange}`);
			}

			if (shouldDeferLargeWriteDiff(ctx, parseKey, previousContent ?? "", content)) {
				const body = ctx.state?._writePreviewDisplay as string | undefined;
				return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
			}
			const diffResult = asyncDiff.get(parseKey) as WriteDiffData | undefined;
			let diff: ParsedDiff;
			let hunks: number;
			if (diffResult) {
				diff = diffResult.diff;
				hunks = diffResult.hunks;
			} else {
				if (ctx.state) ctx.state._writePreviewKey = key;
				const diffError = asyncDiff.getError(parseKey);
				if (diffError) {
					const body = ctx.state?._writePreviewDisplay as string | undefined;
					const err = indentBranchBlock(withBranch(theme.fg("warning", `diff preview: ${diffError}`), theme, false, true));
					return makeText(ctx.lastComponent, body ? `${hdr}\n${body}\n${err}` : `${hdr}\n${err}`);
				}
				asyncDiff.requestLatest(
					{ kind: "write-diff", key: parseKey, oldText: previousContent ?? "", newText: content },
					{
						channel: `write:${toolCallId ?? (fp || parseKey)}`,
						onComplete: () => {
							if (ctx.state?._writePreviewActiveKey === key || ctx.state?._writePreviewKey === key) safeInvalidate(ctx);
						},
					},
				);
				const body = ctx.state?._writePreviewDisplay as string | undefined;
				return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
			}

			const isNew = previousContent === null;
			const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit();
			const mode = isNew ? "new file" : shouldUseSplit(diff, diffWidth, previewLines) ? "split" : "unified";
			const richSummary = diffSummaryWithMeta(diff.added, diff.removed, hunks, mode);
			if (ctx.state._writePreviewKey !== key) {
				ctx.state._writePreviewKey = key;
				if (!ctx.state._writePreviewDisplay) {
					ctx.state._writePreviewDisplay = indentBranchBlock(withBranch(theme.fg("muted", "rendering diff…"), theme, false, true));
				}
			}
			if (ctx.state._writePreviewDisplayKey !== key && ctx.state._writePreviewPendingKey !== key) {
				const dc = resolveDiffColors(theme);
				scheduleKeyedAsyncPreviewRender({
					state: ctx.state,
					key,
					pendingKey: "_writePreviewPendingKey",
					displayKey: "_writePreviewDisplayKey",
					isCurrent: () => ctx.state?._writePreviewKey === key,
					yieldBeforeRender: true,
					render: () => (isNew
						? renderUnified(diff, lang(fp), previewLines, dc, diffWidth)
						: renderSplit(diff, lang(fp), previewLines, dc, diffWidth)
					).catch(() => richSummary),
					commit: (body) => {
						if (ctx.state._writePreviewKey !== key) return;
						ctx.state._writePreviewBody = body;
						ctx.state._writePreviewDisplay = indentBranchBlock(withBranch(body, theme, false, true));
						ctx.state._writePreviewDisplayKey = key;
						safeInvalidate(ctx);
					},
				});
			}
			const body = ctx.state._writePreviewDisplay as string | undefined;
			return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
			if (isPartial) {
				return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Writing..."), expanded, theme, ctx));
			}
			clearBlinkTimer(ctx);
			setToolStatus(ctx, ctx.isError ? "error" : "success");
			if (typeof ctx?.toolCallId === "string") WRITE_EXISTED_BEFORE.delete(ctx.toolCallId);
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				return makeText(ctx.lastComponent, withBranch(theme.fg("error", e), theme));
			}
			const d = (result as any).details;
			if (d?._type === "diff") {
				const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit();
				const hunks = d.diff?.lines?.filter((l: any) => l.type === "sep").length + (d.diff?.lines?.length ? 1 : 0);
				const diffWidth = branchDiffWidth();
				const mode = shouldUseSplit(d.diff, diffWidth, previewLines) ? "split" : "unified";
				const richSummary = diffSummaryWithMeta(d.diff.added, d.diff.removed, hunks, mode);
				if (ctx.state?._writePreviewDisplay) return makeText(ctx.lastComponent, withBranch(richSummary, theme));
				const key = `wd:${diffWidth}:${d.summary}:${d.diff?.lines?.length ?? 0}:${d.language ?? ""}:${ctx.expanded ? 1 : 0}`;
				if (ctx.state._wdActiveKey !== key) {
					ctx.state._wdActiveKey = key;
					ctx.state._wdt = withFinalBranchBlock(`${richSummary}\n${theme.fg("muted", "rendering diff…")}`, theme);
					delete ctx.state._wdDisplayKey;
				}
				if (ctx.state._wdDisplayKey !== key && ctx.state._wdPendingKey !== key) {
					const dc = resolveDiffColors(theme);
					scheduleKeyedAsyncPreviewRender({
						state: ctx.state,
						key,
						pendingKey: "_wdPendingKey",
						displayKey: "_wdDisplayKey",
						isCurrent: () => ctx.state?._wdActiveKey === key,
						yieldBeforeRender: true,
						render: () => renderSplit(d.diff, d.language, previewLines, dc, diffWidth).catch(() => richSummary),
						commit: (body) => {
							if (ctx.state._wdActiveKey !== key) return;
							ctx.state._wdt = body === richSummary ? withBranch(richSummary, theme) : withFinalBranchBlock(`${richSummary}\n${body}`, theme);
							ctx.state._wdDisplayKey = key;
							safeInvalidate(ctx);
						},
					});
				}
				return makeText(ctx.lastComponent, ctx.state._wdt ?? withBranch(richSummary, theme));
			}
			if (d?._type === "noChange") return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "✓ no changes"), theme));
			if (d?._type === "new") {
				const content = typeof ctx.args?.content === "string" ? ctx.args.content : "";
				const lineTotal = typeof d.lines === "number" ? d.lines : lineCount(content);
				const contentHash = hashText(content);
				const syntheticDiff = getCachedParsedDiff(ctx, `nf-diff:${d.filePath}:${contentHash}`, "", content);
				const richSummary = diffSummaryWithMeta(syntheticDiff.added, 0, 1, "new file");
				if (ctx.state?._writePreviewDisplay) return makeText(ctx.lastComponent, withBranch(`${richSummary} ${theme.fg("muted", `(${lineTotal} lines)`)}`, theme));
				const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit();
				const diffWidth = branchDiffWidth();
				const pk = `nf:${d.filePath}:${contentHash}:${diffWidth}:${ctx.expanded ? 1 : 0}`;
				if (ctx.state._nfActiveKey !== pk) {
					ctx.state._nfActiveKey = pk;
					ctx.state._nft = withFinalBranchBlock(`${richSummary}\n${theme.fg("muted", "rendering diff…")}`, theme);
					delete ctx.state._nfDisplayKey;
				}
				if (ctx.state._nfDisplayKey !== pk && ctx.state._nfPendingKey !== pk) {
					const dc = resolveDiffColors(theme);
					const fallback = `${richSummary} ${theme.fg("muted", `(${lineTotal} lines)`)}`;
					scheduleKeyedAsyncPreviewRender({
						state: ctx.state,
						key: pk,
						pendingKey: "_nfPendingKey",
						displayKey: "_nfDisplayKey",
						isCurrent: () => ctx.state?._nfActiveKey === pk,
						yieldBeforeRender: true,
						render: () => renderUnified(syntheticDiff, lang(d.filePath), previewLines, dc, diffWidth).catch(() => fallback),
						commit: (body) => {
							if (ctx.state._nfActiveKey !== pk) return;
							ctx.state._nft = body === fallback ? withBranch(fallback, theme) : withFinalBranchBlock(`${richSummary}\n${body}`, theme);
							ctx.state._nfDisplayKey = pk;
							safeInvalidate(ctx);
						},
					});
				}
				return makeText(ctx.lastComponent, ctx.state._nft ?? withBranch(`${richSummary} ${theme.fg("muted", `(${lineTotal} lines)`)}`, theme));
			}
			return makeText(ctx.lastComponent, withBranch(theme.fg("success", "Written"), theme));
		},
	});
}
