// @ts-nocheck
import { createFindTool, createGrepTool, createLsTool } from "@earendil-works/pi-coding-agent";

import { withBranch } from "../render/branch";
import { buildPreviewTextMapped, previewTruncationSuffix } from "../render/preview";

export function registerSearchTools(deps: any): void {
	const {
		pi, cwd, clearBlinkTimer, collapsedPreviewCount, dirIcon, D_RST, FG_RULE, fileIcon,
		formatGroupedGrepPreview, formatRtkCompactionDetails, getGrepGroupedSummary,
		getRtkCompaction, makeText, previewLimit, runningPreviewBlock, setToolStatus, sp,
		stableCallSummary, summarizeText, syncToolCallStatus, toolHeader, toolOutputDetailHint,
		toolStatusDot,
	} = deps;

const grepTool = createGrepTool(cwd);
pi.registerTool({
	name: "grep",
	label: "grep",
	description: grepTool.description,
	parameters: grepTool.parameters,
	async execute(toolCallId, params, signal, onUpdate) {
		return grepTool.execute(toolCallId, params, signal, onUpdate);
	},
	renderCall(args, theme, ctx) {
		syncToolCallStatus(ctx);
		const summary = stableCallSummary(ctx, "_callSummary", () => {
			let value = `\"${summarizeText(args.pattern, 40)}\"`;
			if (args.path) value += ` in ${args.path}`;
			return value;
		});
		return makeText(ctx.lastComponent, toolHeader("Grep", summary, theme, toolStatusDot(ctx, theme)));
	},
	renderResult(result, { expanded, isPartial }, theme, ctx) {
		if (isPartial) {
			return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Searching..."), expanded, theme, ctx));
		}
		clearBlinkTimer(ctx);
		setToolStatus(ctx, ctx.isError ? "error" : "success");
		const details = result.details as GrepToolDetails | undefined;
		const rtkCompaction = getRtkCompaction(details);
		const matches = (result.content[0]?.type === "text" ? result.content[0].text : "")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		if (matches.length === 0) {
			let text = theme.fg("muted", "no matches");
			if (expanded && rtkCompaction) text += `\n${formatRtkCompactionDetails(rtkCompaction, theme)}`;
			return makeText(ctx.lastComponent, withBranch(text, theme));
		}
		const grouped = getGrepGroupedSummary(matches);
		let text = theme.fg("muted", `${grouped.count} matches${grouped.files !== undefined ? ` in ${grouped.files} files` : ""}`);
		if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
		if (!expanded) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
		if (rtkCompaction) text += `\n${formatRtkCompactionDetails(rtkCompaction, theme)}`;
		const previewLines = grouped.header ? matches.filter((line) => line !== grouped.header) : matches;
		if (rtkCompaction) {
			const maxPreviewLines = collapsedPreviewCount(expanded, previewLimit());
			const shownPreviewLines = previewLines.slice(0, maxPreviewLines);
			const formattedPreview = formatGroupedGrepPreview(shownPreviewLines, ctx.args, theme);
			text += `\n${formattedPreview.join("\n")}${previewTruncationSuffix(previewLines.length, shownPreviewLines.length, expanded, theme, maxPreviewLines)}`;
		} else {
			text += `\n${buildPreviewTextMapped(previewLines, expanded, theme, previewLimit(), (line) => theme.fg("dim", line))}`;
		}
		return makeText(ctx.lastComponent, withBranch(text, theme));
	},
});

const findTool = createFindTool(cwd);
pi.registerTool({
	name: "find",
	label: "find",
	description: findTool.description,
	parameters: findTool.parameters,
	async execute(toolCallId, params, signal, onUpdate) {
		return findTool.execute(toolCallId, params, signal, onUpdate);
	},
	renderCall(args, theme, ctx) {
		syncToolCallStatus(ctx);
		const summary = stableCallSummary(ctx, "_callSummary", () => {
			let value = `\"${summarizeText(args.pattern, 40)}\"`;
			if (args.path) value += ` in ${args.path}`;
			return value;
		});
		return makeText(ctx.lastComponent, toolHeader("Find", summary, theme, toolStatusDot(ctx, theme)));
	},
	renderResult(result, { expanded, isPartial }, theme, ctx) {
		if (isPartial) {
			return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Finding..."), expanded, theme, ctx));
		}
		clearBlinkTimer(ctx);
		setToolStatus(ctx, ctx.isError ? "error" : "success");
		const items = (result.content[0]?.type === "text" ? result.content[0].text : "")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		if (items.length === 0) return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "no files found"), theme));
		let text = theme.fg("muted", `${items.length} files`);
		if (!expanded) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
		// Expanded: grouped find results with icons
		const maxShow = previewLimit();
		const shown = items.slice(0, maxShow);
		const findLines: string[] = [];
		for (let i = 0; i < shown.length; i++) {
			const item = shown[i].trim();
			const icon = fileIcon(item);
			findLines.push(`  ${icon}${theme.fg("dim", item)}`);
		}
		const remaining = items.length - shown.length;
		if (remaining > 0) {
			findLines.push(`  ${theme.fg("muted", `… ${remaining} more files`)}`);
		}
		text += `\n${findLines.join('\n')}`;
		return makeText(ctx.lastComponent, withBranch(text, theme));
	},
});

const lsTool = createLsTool(cwd);
pi.registerTool({
	name: "ls",
	label: "ls",
	description: lsTool.description,
	parameters: lsTool.parameters,
	async execute(toolCallId, params, signal, onUpdate) {
		return lsTool.execute(toolCallId, params, signal, onUpdate);
	},
	renderCall(args, theme, ctx) {
		syncToolCallStatus(ctx);
		const summary = stableCallSummary(ctx, "_callSummary", () => sp(args.path ?? "."));
		return makeText(ctx.lastComponent, toolHeader("List", summary, theme, toolStatusDot(ctx, theme)));
	},
	renderResult(result, { expanded, isPartial }, theme, ctx) {
		if (isPartial) {
			return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Listing..."), expanded, theme, ctx));
		}
		clearBlinkTimer(ctx);
		setToolStatus(ctx, ctx.isError ? "error" : "success");
		const items = (result.content[0]?.type === "text" ? result.content[0].text : "")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		if (items.length === 0) return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "empty directory"), theme));
		let text = theme.fg("muted", `${items.length} entries`);
		if (!expanded) return makeText(ctx.lastComponent, withBranch(`${text}${toolOutputDetailHint(theme, expanded)}`, theme));
		// Expanded: tree-view with icons
		const maxShow = previewLimit();
		const shown = items.slice(0, maxShow);
		const treeLines: string[] = [];
		for (let i = 0; i < shown.length; i++) {
			const item = shown[i];
			const isDir = item.endsWith("/");
			const isLast = i === shown.length - 1 && items.length <= maxShow;
			const prefix = isLast ? `${FG_RULE}\u2514\u2500\u2500${D_RST} ` : `${FG_RULE}\u251c\u2500\u2500${D_RST} `;
			const icon = isDir ? dirIcon() : fileIcon(item);
			const name = isDir ? theme.fg("accent", theme.bold(item)) : theme.fg("dim", item);
			treeLines.push(`${prefix}${icon}${name}`);
		}
		const remaining = items.length - shown.length;
		if (remaining > 0) {
			treeLines.push(`${FG_RULE}\u2514\u2500\u2500${D_RST} ${theme.fg("muted", `\u2026 ${remaining} more entries`)}`);
		}
		text += `\n${treeLines.join('\n')}`;
		return makeText(ctx.lastComponent, withBranch(text, theme));
	},
});
}
