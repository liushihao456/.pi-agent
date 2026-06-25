// @ts-nocheck
import { createBashTool } from "@earendil-works/pi-coding-agent";

import { withBranch } from "../render/branch";
import { buildPreviewTextMapped } from "../render/preview";

export function registerBashTool(deps: any): void {
	const {
		pi, cwd, bashCollapsedLimit, buildPersistentBashPreview, clearBlinkTimer,
		ensureRtkRewriteForContext, formatRtkRewriteDetails, makeText, preserveBashPreview,
		runningPreviewBlock, setToolStatus, shouldPreserveBashPreview, stableCallSummary,
		summarizeText, syncToolCallStatus, toolHeader, toolOutputDetailHint, toolStatusDot,
	} = deps;

const bashTool = createBashTool(cwd);
pi.registerTool({
	name: "bash",
	label: "bash",
	description: bashTool.description,
	parameters: bashTool.parameters,
	async execute(toolCallId, params, signal, onUpdate) {
		return bashTool.execute(toolCallId, params, signal, onUpdate);
	},
	renderCall(args, theme, ctx) {
		syncToolCallStatus(ctx);
		const rewrite = ensureRtkRewriteForContext(ctx, args);
		const summary = stableCallSummary(ctx, "_callSummary", () => summarizeText(args.command, 72));
		const rtkBadge = rewrite ? theme.fg("muted", " (RTK)") : "";
		return makeText(ctx.lastComponent, toolHeader("Bash", `${summary}${rtkBadge}`, theme, toolStatusDot(ctx, theme)));
	},
	renderResult(result, { expanded, isPartial }, theme, ctx) {
		const details = result.details as BashToolDetails | undefined;
		const rewrite = ensureRtkRewriteForContext(ctx, ctx.args);
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";
		const nonEmpty = output.split("\n").filter((line) => line.trim().length > 0);
		if (isPartial) {
			const running = runningPreviewBlock(result, theme.fg("warning", "Running..."), expanded, theme, ctx, {
				lines: nonEmpty,
				styleLine: (line) => theme.fg("dim", line),
				tail: true,
			});
			const withRewrite = expanded && rewrite ? `${running}\n${withBranch(formatRtkRewriteDetails(rewrite, theme), theme)}` : running;
			return makeText(ctx.lastComponent, withRewrite);
		}
		clearBlinkTimer(ctx);
		setToolStatus(ctx, ctx.isError ? "error" : "success");
		if (nonEmpty.length > 0 && ctx.state?._bashPreviewReleased !== true) {
			preserveBashPreview(ctx);
			if (ctx.state) ctx.state._bashPreviewReleased = true;
		}
		const exitMatch = output.match(/exit code: (\d+)/);
		const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;
		let text = exitCode === null || exitCode === 0 ? theme.fg("success", "Done") : theme.fg("error", `Exit ${exitCode}`);
		text += theme.fg("muted", ` (${nonEmpty.length} lines)`);
		if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");
		const persistentPreview = shouldPreserveBashPreview(ctx) ? buildPersistentBashPreview(nonEmpty, theme) : "";
		if (!expanded && persistentPreview) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}\n${persistentPreview}`, theme));
		if (!expanded && nonEmpty.length > 0) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
		if (!expanded) return makeText(ctx.lastComponent, withBranch(text, theme));
		const collapsed = bashCollapsedLimit();
		if (rewrite) text += `\n${formatRtkRewriteDetails(rewrite, theme)}`;
		text += `\n${buildPreviewTextMapped(nonEmpty, true, theme, collapsed, (line) => theme.fg("dim", line))}`;
		return makeText(ctx.lastComponent, withBranch(text, theme));
	},
});
}
