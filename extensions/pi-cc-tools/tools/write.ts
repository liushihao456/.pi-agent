import { createWriteTool } from "@earendil-works/pi-coding-agent";

import {
	codeToAnsiLazy,
	DIFF_THEME,
	lang,
	MAX_RENDER_LINES,
} from "../diff/render";
import { withBranch } from "../render/branch";
import { scheduleKeyedAsyncPreviewRender } from "../render/scheduler";

const NOWRAP_MARK = "\uE001";

async function renderWrittenContentPreview(
	content: string,
	filePath: string,
	lineTotal: number,
	maxLines: number,
	collapsedLines: number,
	theme: any,
	expanded: boolean,
	toolOutputDetailHint: (theme: any, expanded: boolean, hasMore?: boolean) => string,
): Promise<string> {
	const lines = content.split("\n");
	const shown = lines.slice(0, maxLines);
	const nw = Math.max(3, String(Math.max(1, lineTotal, lines.length)).length);
	let highlighted: string[] | null = null;
	const language = lang(filePath);
	if (language) {
		try {
			const ansi = await codeToAnsiLazy(shown.join("\n"), language, DIFF_THEME);
			highlighted = ansi.endsWith("\n") ? ansi.slice(0, -1).split("\n") : ansi.split("\n");
		} catch {
			highlighted = null;
		}
	}
	const body = [theme.fg("muted", `${lineTotal} lines written`)];
	body.push(...shown.map((line, index) => {
		const lineNo = String(index + 1).padStart(nw);
		const rendered = highlighted?.[index] ?? theme.fg("dim", line || " ");
		return `${NOWRAP_MARK}${theme.fg("muted", lineNo)} ${theme.fg("dim", "│")} ${rendered || " "}`;
	}));
	if (lines.length > shown.length) {
		body.push(theme.fg("muted", `… ${lines.length - shown.length} more lines${toolOutputDetailHint(theme, expanded, true)}`));
	} else if (expanded && lines.length > collapsedLines) {
		body.push(theme.fg("muted", `…${toolOutputDetailHint(theme, expanded, true)}`));
	}
	return body.join("\n");
}

export function registerWriteTool(deps: any): void {
	const {
		pi,
		cwd,
		clearBlinkTimer,
		diffCollapsedLimit,
		fileExistsForTool,
		hashText,
		lineCount,
		makeText,
		runningPreviewBlock,
		safeInvalidate,
		setToolStatus,
		shouldRevealCallArgs,
		sp,
		stableCallSummary,
		syncToolCallStatus,
		toolHeader,
		toolOutputDetailHint,
		toolPathArg,
		toolStatusDot,
	} = deps;

	const writeTool = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: writeTool.description,
		parameters: writeTool.parameters,
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, _ctx: any) {
			const fp = toolPathArg(params);
			const writeParams = fp && params.path !== fp ? { ...(params as any), path: fp } : params;
			const existedBefore = !!fp && fileExistsForTool(cwd, fp);
			const result = await writeTool.execute(toolCallId, writeParams, signal, onUpdate);
			const content = writeParams.content ?? "";
			(result as any).details = {
				_type: existedBefore ? "overwrite" : "new",
				lines: lineCount(content),
				filePath: fp,
			};
			return result;
		},
		renderCall(args: any, theme: any, ctx: any) {
			const fp = toolPathArg(args);
			const content = typeof args?.content === "string" ? args.content : undefined;
			const revealSummary = shouldRevealCallArgs(ctx) || content !== undefined;
			syncToolCallStatus(ctx);
			const summary = stableCallSummary(ctx, "_callSummary", () => sp(fp), revealSummary);
			const hdr = toolHeader("Write", summary, theme, toolStatusDot(ctx, theme));
			if (content === undefined) return makeText(ctx.lastComponent, hdr);

			const contentHash = hashText(content);
			const lineTotal = lineCount(content);
			const collapsedPreviewLines = diffCollapsedLimit();
			const previewLines = ctx.expanded ? MAX_RENDER_LINES : collapsedPreviewLines;
			const key = `write-content:${fp}:${contentHash}:${previewLines}:${ctx.expanded ? 1 : 0}`;
			if (ctx.state._writePreviewKey !== key) {
				ctx.state._writePreviewKey = key;
				if (!ctx.state._writePreviewDisplay) {
					ctx.state._writePreviewDisplay = withBranch(theme.fg("muted", "rendering preview…"), theme);
				}
				delete ctx.state._writePreviewDisplayKey;
			}
			if (ctx.state._writePreviewDisplayKey !== key && ctx.state._writePreviewPendingKey !== key) {
				scheduleKeyedAsyncPreviewRender({
					state: ctx.state,
					key,
					pendingKey: "_writePreviewPendingKey",
					displayKey: "_writePreviewDisplayKey",
					isCurrent: () => ctx.state?._writePreviewKey === key,
					yieldBeforeRender: true,
					render: () => renderWrittenContentPreview(content, fp, lineTotal, previewLines, collapsedPreviewLines, theme, ctx.expanded, toolOutputDetailHint),
					commit: (body) => {
						if (ctx.state._writePreviewKey !== key) return;
						ctx.state._writePreviewDisplay = withBranch(body, theme);
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
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				return makeText(ctx.lastComponent, withBranch(theme.fg("error", e), theme));
			}
			return makeText(ctx.lastComponent, "");
		},
	});
}
