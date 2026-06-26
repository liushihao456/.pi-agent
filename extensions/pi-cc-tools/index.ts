import { existsSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";

import type {
	ExtensionAPI,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	keyHint,
	keyText,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	deleteAllKittyImages,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { BundledTheme } from "shiki";

import { AsyncDiffService } from "./diff/async-service";
import {
	branchDiffWidth,
	clearHighlightCache,
	codeToAnsiLazy,
	detectLang,
	diffSummaryWithMeta,
	lang,
	renderSplit,
	setDiffRenderPalette,
	shouldUseSplit,
	summarizeDiff,
} from "./diff/render";
import type { DiffColors } from "./diff/types";
import { clampLineWidth, isBlankLine, padRenderedLineToWidth, padToWidth, stripAnsi } from "./render/ansi";
import { configureBranchRenderer, indentBranchBlock, withBranch, withFinalBranchBlock } from "./render/branch";
import { buildPreviewText, buildPreviewTextMapped, configurePreviewRenderer, previewTruncationSuffix } from "./render/preview";
import { configureMarkdownRenderer, DottedParagraph, makeMarkdownLinksCopySafe, ThinkingParagraph } from "./markdown/render";
import { bustSpinnerSettingsCache, invalidateSettingsCache, readSettings, writeSettingsKey } from "./settings/config";
import { bashCollapsedLimit, collapsedPreviewCount, diffCollapsedLimit, expandedPreviewLimit, liveToolPreviewEnabled, liveToolPreviewLimit, previewLimit } from "./settings/limits";
import { configureApplyPatchRenderer, renderApplyPatchCall, renderApplyPatchResult } from "./tools/apply-patch";
import { registerBashTool } from "./tools/bash";
import { registerEditTool } from "./tools/edit";
import { registerReadTool } from "./tools/read";
import { registerSearchTools } from "./tools/search";
import { configureGenericToolRenderer, humanizeToolName, renderGenericToolCall, renderGenericToolResult, shouldUseGenericToolRenderer } from "./tools/generic";
import { configureMcpToolRenderer, registerMcpToolOverrides } from "./tools/mcp";
import { configureOpenAiToolRenderer, registerOpenAiToolOverrides, summarizeOpenAiToolCall } from "./tools/openai";
import { registerWriteTool } from "./tools/write";

const RESET = "\x1b[0m";
const TRANSPARENT_BG = "\x1b[49m";
const TRANSPARENT_RESET = `${RESET}${TRANSPARENT_BG}`;

// User/code box borders and thinking/thought text: branch color + OUTLINE_CHROME_BRIGHTEN.
// Branch ├─└─│ stay at `currentToolBranchAnsi` (see syncOutlineChromeFromBranch).
let BORDER_COLOR = "\x1b[38;5;238m";
let CODE_BLOCK_LANG_FG = "\x1b[38;2;95;95;95m";
const CHROME_ITALIC = "\x1b[3m";
/** Lift outline chrome above branch connectors so boxes and thought read brighter. */
const OUTLINE_CHROME_BRIGHTEN = 64;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_PRESENT_RE = /\x1b\[[0-9;]*m/;
const PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-container-render");
const TOOL_RENDER_CACHE = Symbol.for("pi-claude-style-tools:tool-render-cache");
const COMPONENT_PARENT = Symbol.for("pi-claude-style-tools:component-parent");
const PARENT_TRACKING_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-parent-tracking");
const TOOL_CACHE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-cache-invalidation");
const TOOL_IMAGE_EXPAND_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-read-image-expansion");
const CUSTOM_MESSAGE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-custom-message-render");
const USER_MESSAGE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-user-message-render");
const RTK_NOTIFY_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-rtk-notify");
const WRAP_MARK = "\uE000";
const NOWRAP_MARK = "\uE001";
const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM2_IMAGE_PREFIX = "\x1b]1337;File=";

let toolBackgroundMode: "default" | "transparent" | "outlines" = "outlines";

let toolBackgroundOverride: "default" | "transparent" | "outlines" | null = null;

function syncToolBackgroundMode(): void {
	if (toolBackgroundOverride) {
		toolBackgroundMode = toolBackgroundOverride;
		return;
	}
	const settings = readSettings();
	// Backward compat: "border" was renamed to "outlines"
	const raw = settings.toolBackground === "border" ? "outlines" : settings.toolBackground;
	toolBackgroundMode = raw ?? "outlines";
}

function setThemeBg(theme: unknown, key: string, value: string): void {
	const themeAny = theme as any;
	if (themeAny.bgColors instanceof Map) {
		themeAny.bgColors.set(key, value);
	} else if (themeAny.bgColors && typeof themeAny.bgColors === "object") {
		themeAny.bgColors[key] = value;
	}
}

const PI_GLOBAL_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

function getGlobalPiTheme(): unknown {
	return (globalThis as any)[PI_GLOBAL_THEME_KEY];
}

/** Pi's ToolExecutionComponent reads `theme` from globalThis — keep it in sync with ctx.ui.theme. */
function applyToolBackgroundMode(theme: unknown): void {
	syncToolBackgroundMode();
	const targets = new Set<unknown>();
	if (theme) targets.add(theme);
	const globalTheme = getGlobalPiTheme();
	if (globalTheme) targets.add(globalTheme);
	for (const t of targets) {
		setThemeBg(t, "userMessageBg", TRANSPARENT_BG);
		if (toolBackgroundMode === "default") continue;
		setThemeBg(t, "toolPendingBg", TRANSPARENT_BG);
		setThemeBg(t, "toolSuccessBg", TRANSPARENT_BG);
		setThemeBg(t, "toolErrorBg", TRANSPARENT_BG);
	}
}


function stripRenderedHeadingMarkers(line: string): string {
	return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t])*)#{3,6}[ \t]*((?:\x1b\[[0-9;]*m)*)/, "$1$2");
}

const PLAIN_FENCE_LANGS = new Set(["text", "txt", "plain", "plaintext", ""]);

function parseRenderedFenceLine(line: string): { kind: "open" | "close"; language: string } | undefined {
	const plain = stripAnsi(line).trim();
	if (plain === "```") return { kind: "close", language: "" };
	if (!plain.startsWith("```")) return undefined;
	const rest = plain.slice(3).trim();
	if (rest.includes("`")) return undefined;
	return { kind: "open", language: rest };
}

function formatCodeBlockLanguageLabel(language: string): string {
	const raw = language.trim();
	if (!raw) return "";
	return raw.toLowerCase();
}

function mutedDotFill(count: number): string {
	if (count <= 0) return "";
	return `${BORDER_COLOR}${"·".repeat(count)}${TRANSPARENT_RESET}`;
}


function isCodeBoxChromeLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	if (!plain) return false;
	if (/^[╭╮╰╯│·\s]+$/.test(plain) && /[╭╮╰╯│]/.test(plain)) return true;
	if (/^╭/.test(plain) && /╮$/.test(plain)) return true;
	if (/^╰/.test(plain) && /╯$/.test(plain)) return true;
	return false;
}

function isUserMessageChromeLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	if (/^╭/.test(plain) && /╮$/.test(plain)) return true;
	if (/^╰/.test(plain) && /╯$/.test(plain)) return true;
	return false;
}

function isBorderedContentLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return plain.startsWith("│") && plain.endsWith("│") && plain.length > 2;
}

function extractBorderedInnerForCopy(line: string): string {
	const plain = stripAnsi(line);
	const start = plain.indexOf("│");
	const end = plain.lastIndexOf("│");
	if (start === -1 || end <= start) return stripAnsi(line).trim();
	return plain.slice(start + 1, end).replace(/^\s+/, "").replace(/\s+$/, "");
}

function applyTerminalCopyZones(lines: string[]): string[] {
	if (!Array.isArray(lines) || lines.length === 0) return lines;
	const out: string[] = [];
	let inZone = false;
	for (const line of lines) {
		if (isCopyExcludedChromeLine(line)) {
			if (inZone) {
				out[out.length - 1] += OSC133_ZONE_END;
				inZone = false;
			}
			out.push(line);
			continue;
		}
		const payload = copyPayloadForLine(line);
		if (!payload) {
			out.push(line);
			continue;
		}
		if (!inZone) {
			out.push(`${OSC133_ZONE_START}${line}`);
			inZone = true;
		} else {
			out.push(line);
		}
	}
	if (inZone && out.length > 0) {
		out[out.length - 1] += OSC133_ZONE_END + OSC133_ZONE_FINAL;
	}
	return out;
}

function isCopyExcludedChromeLine(line: string): boolean {
	return isCodeBoxChromeLine(line) || isUserMessageChromeLine(line);
}

function copyPayloadForLine(line: string): string | undefined {
	if (isCopyExcludedChromeLine(line)) return undefined;
	if (isBorderedContentLine(line)) return extractBorderedInnerForCopy(line);
	const plain = stripAnsi(line).trim();
	if (!plain) return undefined;
	return plain;
}

function roundedCodeBlockTop(width: number, language: string): string {
	if (width <= 1) return `${BORDER_COLOR}│${TRANSPARENT_RESET}`;
	const label = formatCodeBlockLanguageLabel(language);
	if (!label || width < 8) {
		const inner = Math.max(0, width - 2);
		return `${BORDER_COLOR}╭${TRANSPARENT_RESET}${mutedDotFill(inner)}${BORDER_COLOR}╮${TRANSPARENT_RESET}`;
	}
	const labelStyled = `${CODE_BLOCK_LANG_FG}${CHROME_ITALIC}${label}${RESET}${TRANSPARENT_RESET}`;
	const labelW = visibleWidth(labelStyled);
	const dotCount = Math.max(0, width - 6 - labelW);
	return `${BORDER_COLOR}╭· ${TRANSPARENT_RESET}${labelStyled} ${mutedDotFill(dotCount)}${BORDER_COLOR} ╮${TRANSPARENT_RESET}`;
}

function roundedCodeBlockBottom(width: number): string {
	if (width <= 1) return `${BORDER_COLOR}│${TRANSPARENT_RESET}`;
	const inner = Math.max(0, width - 2);
	return `${BORDER_COLOR}╰${TRANSPARENT_RESET}${mutedDotFill(inner)}${BORDER_COLOR}╯${TRANSPARENT_RESET}`;
}

function borderedCodeBlockLine(line: string, width: number): string {
	const innerWidth = Math.max(1, width - 4);
	let content = line;
	if (visibleWidth(content) > innerWidth) {
		content = truncateToWidth(content, innerWidth, "", false);
	}
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
	return `${BORDER_COLOR}│${TRANSPARENT_RESET} ${content}${padding} ${BORDER_COLOR}│${TRANSPARENT_RESET}`;
}

function boxRenderedCodeBlock(bodyLines: string[], language: string, width: number): string[] {
	const safeWidth = Math.max(4, Number.isFinite(width) ? Math.floor(width) : 0);
	const framed = [
		roundedCodeBlockTop(safeWidth, language),
		...bodyLines.map((line) => borderedCodeBlockLine(line, safeWidth)),
		roundedCodeBlockBottom(safeWidth),
	];
	return framed.map((line) => padRenderedLineToWidth(line, safeWidth));
}

function sanitizeRenderedTextBlockLines(lines: string[], width?: number): string[] {
	const result: string[] = [];
	let i = 0;
	const canBox = typeof width === "number" && width > 0;
	while (i < lines.length) {
		const fence = parseRenderedFenceLine(lines[i]);
		if (fence?.kind === "open") {
			const language = fence.language;
			const hideBox = PLAIN_FENCE_LANGS.has(language.trim().toLowerCase());
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const close = parseRenderedFenceLine(lines[i]);
				if (close?.kind === "close") {
					i++;
					break;
				}
				body.push(lines[i]);
				i++;
			}
			if (hideBox) {
				result.push(...body);
			} else if (canBox && (body.length > 0 || language.trim())) {
				result.push(...boxRenderedCodeBlock(body, language, width));
			} else {
				result.push(...body);
			}
			continue;
		}
		if (fence?.kind === "close") {
			i++;
			continue;
		}
		result.push(stripRenderedHeadingMarkers(lines[i]).replace(/###/g, ""));
		i++;
	}
	return result;
}


function borderLine(width: number): string {
	return `${BORDER_COLOR}${"─".repeat(Math.max(1, width))}${TRANSPARENT_RESET}`;
}


function isToolExecutionLike(value: unknown): value is { toolName: string; toolCallId: string } {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.toolName === "string" && typeof candidate.toolCallId === "string";
}

function shouldIndentToolExecution(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const toolName = (value as Record<string, unknown>).toolName;
	return typeof toolName === "string" && ["Agent", "Agents", "get_subagent_result", "steer_subagent"].includes(toolName);
}

function isTerminalImageLine(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM2_IMAGE_PREFIX);
}

function normalizeLeadingCheckGlyph(line: string): string {
	return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)[✓✔]((?:\x1b\[[0-9;]*m)*)(?=\s)/, "$1●$2");
}

function firstImageBlockStart(lines: string[]): number {
	const imageLineIndex = lines.findIndex(isTerminalImageLine);
	if (imageLineIndex === -1) return -1;
	let start = imageLineIndex;
	while (start > 0 && isBlankLine(lines[start - 1])) start--;
	return start;
}

function splitRenderedImageBlock(lines: string[]): { textLines: string[]; imageLines: string[] } {
	const imageStart = firstImageBlockStart(lines);
	if (imageStart === -1) return { textLines: lines, imageLines: [] };
	const textLines = lines.slice(0, imageStart);
	while (textLines.length > 0 && isBlankLine(textLines[textLines.length - 1])) textLines.pop();
	return { textLines, imageLines: lines.slice(imageStart) };
}

function toolGroupingEnabled(): boolean {
	return readSettings().groupToolCalls !== false;
}

function setToolGroupingEnabled(enabled: boolean): void {
	writeSettingsKey("groupToolCalls", enabled);
}

type ToolStatus = "pending" | "success" | "error";

function getToolStatusForGroup(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.result && tool?.isPartial !== true) return "success";
	return "pending";
}

let TOOL_STATUS_SUCCESS = "\x1b[32m";
let TOOL_STATUS_ERROR = "\x1b[31m";
let TOOL_STATUS_PENDING = "\x1b[90m";

function statusText(status: ToolStatus, count: number): string {
	const label = status === "success" ? "done" : status === "error" ? "failed" : "running";
	const color = status === "success" ? TOOL_STATUS_SUCCESS : status === "error" ? TOOL_STATUS_ERROR : TOOL_STATUS_PENDING;
	return `${color}${count}${TRANSPARENT_RESET} ${label}`;
}

function countToolStatuses(tools: any[]): Record<ToolStatus, number> {
	return tools.reduce((counts, tool) => {
		counts[getToolStatusForGroup(tool)]++;
		return counts;
	}, { pending: 0, success: 0, error: 0 } as Record<ToolStatus, number>);
}

function formatToolGroupCounts(tools: any[]): string {
	const counts = countToolStatuses(tools);
	const parts: string[] = [];
	if (counts.pending) parts.push(statusText("pending", counts.pending));
	if (counts.success) parts.push(statusText("success", counts.success));
	if (counts.error) parts.push(statusText("error", counts.error));
	return parts.join(`${TRANSPARENT_RESET} • `);
}

function getToolName(tool: any): string {
	return typeof tool?.toolName === "string" && tool.toolName ? tool.toolName : "tool";
}

function getGroupedToolName(tools: any[]): string | undefined {
	const first = getToolName(tools[0]);
	return tools.every((tool) => getToolName(tool) === first) ? first : undefined;
}

function getToolGroupLabel(tools: any[]): string {
	const sameName = getGroupedToolName(tools);
	return sameName ? humanizeToolName(sameName) : "Multiple Tools";
}

function getToolGroupOverallStatus(tools: any[]): ToolStatus {
	const counts = countToolStatuses(tools);
	if (counts.error > 0) return "error";
	if (counts.pending > 0) return "pending";
	return "success";
}

function groupStatusLight(status: ToolStatus): string {
	const color = status === "success" ? TOOL_STATUS_SUCCESS : status === "error" ? TOOL_STATUS_ERROR : TOOL_STATUS_PENDING;
	if (status === "pending") {
		return isBlinkOn() ? `${TOOL_STATUS_SUCCESS}●${TRANSPARENT_RESET}` : `${TOOL_STATUS_PENDING}○${TRANSPARENT_RESET}`;
	}
	return `${color}●${TRANSPARENT_RESET}`;
}

function formatToolNameList(tools: any[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) {
		const name = getToolName(tool);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()]
		.slice(0, 4)
		.map(([name, count]) => `${name}${count > 1 ? `×${count}` : ""}`)
		.join(", ") + (counts.size > 4 ? ", …" : "");
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripGroupedToolLabel(line: string, label: string | undefined): string {
	if (!label) return line;
	const ansi = "(?:\\x1b\\[[0-9;]*m)*";
	const pattern = new RegExp(`^(${ansi})${escapeRegex(label)}(${ansi})\\s+`);
	return line.replace(pattern, "$1$2");
}

function isChromeOnlyLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return plain.length === 0 || /^[─━╭╮╰╯┌┐└┘│├┤┬┴┼\s]+$/.test(plain);
}

function stripToolChrome(lines: string[]): string[] {
	return trimRenderedBlankLines(lines).filter((line) => !isChromeOnlyLine(line));
}

function stripLeadingToolStatus(line: string): string {
	return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)(?:\x1b\[[0-9;]*m)*[●○✗■](?:\x1b\[[0-9;]*m)*\s+/, "$1");
}

function trimAnsiLeft(text: string): string {
	let current = text;
	while (true) {
		const next = current.replace(/^((?:\x1b\[[0-9;]*m)*)[ \t]+/, "$1");
		if (next === current) return current;
		current = next;
	}
}

function removeGroupedToolPrefix(line: string, groupedLabel?: string): string {
	// Group rendering reuses fully-rendered child tool lines. Only strip chrome
	// from header/status lines; preserve body indentation (read gutters, grep
	// match lists, code blocks). A blind trim breaks nested tool formatting.
	const withoutStatus = stripLeadingToolStatus(line);
	const statusRemoved = withoutStatus !== line;
	const labelInput = statusRemoved ? trimAnsiLeft(withoutStatus) : withoutStatus;
	const withoutLabel = stripGroupedToolLabel(labelInput, groupedLabel);
	const labelRemoved = withoutLabel !== labelInput;
	return statusRemoved || labelRemoved ? trimAnsiLeft(withoutLabel) : line;
}

function tintGroupedToolLine(line: string, _groupedLabel?: string): string {
	return line;
}

function getToolArgSummary(tool: any): string {
	const args = tool?.args ?? {};
	const name = getToolName(tool);
	if (name === "read") {
		let value = shortPath(process.cwd(), args.path ?? "");
		const parts: string[] = [];
		if (args.offset) parts.push(`offset=${args.offset}`);
		if (args.limit) parts.push(`limit=${args.limit}`);
		if (parts.length > 0) value += ` (${parts.join(", ")})`;
		return value;
	}
	if (name === "bash") return summarizeText(args.command ?? "", 72);
	if (name === "grep") return `"${summarizeText(args.pattern ?? "", 40)}"${args.path ? ` in ${args.path}` : ""}`;
	if (name === "find") return `"${summarizeText(args.pattern ?? "", 40)}"${args.path ? ` in ${args.path}` : ""}`;
	if (name === "ls") return shortPath(process.cwd(), args.path ?? ".");
	return summarizeText(getStringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt") || name, 72);
}

function getToolCallLine(tool: any): string {
	const value = (tool as any)?.callRendererComponent?.value;
	if (typeof value === "string" && value.trim()) {
		const line = value.split("\n").find((line) => stripAnsi(line).trim()) ?? value;
		return line.replaceAll(WRAP_MARK, "");
	}
	const summary = getToolArgSummary(tool);
	const label = humanizeToolName(getToolName(tool));
	return `${label}${summary ? ` ${summary}` : ""}`;
}

function getCompactToolLine(tool: any, width: number, groupedLabel?: string): string {
	const content = removeGroupedToolPrefix(getToolCallLine(tool), groupedLabel);
	return clampLineWidth(content || getToolName(tool), width);
}

function getExpandedToolGroupLines(tool: any, width: number, groupedLabel?: string): string[] {
	const lines = stripToolChrome(tool.render(Math.max(1, width)))
		.map((line) => removeGroupedToolPrefix(line, groupedLabel))
		.map((line) => tintGroupedToolLine(line, groupedLabel));
	return lines.length > 0 ? lines : [`${FG_DIM}${String(tool?.toolName ?? "tool")}${TRANSPARENT_RESET}`];
}

function branchPrefix(index: number, total: number, theme?: Theme): string {
	const branch = index === total - 1 ? "└─" : "├─";
	const rule = currentToolBranchAnsi(theme);
	return ` ${rule}${branch}${TRANSPARENT_RESET} `;
}

function branchContinuation(index: number, total: number, theme?: Theme): string {
	const rule = currentToolBranchAnsi(theme);
	return index === total - 1 ? "    " : ` ${rule}│${TRANSPARENT_RESET}  `;
}

function stripGroupedToolBodyIndent(line: string): { body: string; startsChildBranch: boolean } {
	// Child tools are rendered once as standalone tool rows. If a continuation
	// line contains the child tool's own branch lead (└─/├─), strip every wrapper
	// byte before that branch so it lands directly after the group continuation,
	// aligned with the child status dot. Re-apply branch color because stripping
	// wrappers can remove the ANSI span that originally colored └─/├─.
	const childBranch = line.match(/^(?:\x1b\[[0-9;]*m|[\uE000\uE001]|[ \t])*([└├]─)(.*)$/u);
	if (childBranch?.[1]) {
		return { body: `${currentToolBranchAnsi()}${childBranch[1]}${TRANSPARENT_RESET}${childBranch[2] ?? ""}`, startsChildBranch: true };
	}

	const gutterMatch = line.match(/^(?:\x1b\[[0-9;]*m|[ \t]|[\uE000\uE001])*(?:[\uE000\uE001])((?:\x1b\[[0-9;]*m|[ \t])*\d+.*)$/u);
	if (gutterMatch?.[1]) {
		const visibleGutter = stripAnsi(gutterMatch[1]);
		if (/^\s*\d+\s*│/.test(visibleGutter)) return { body: `${NOWRAP_MARK}${gutterMatch[1]}`, startsChildBranch: false };
	}

	const leadingTokens = "(?:\\x1b\\[[0-9;]*m|[\\uE000\\uE001])*";
	let current = line;
	for (let i = 0; i < 2; i++) {
		current = current.replace(new RegExp(`^(${leadingTokens}) {1,4}`), "$1");
	}
	return { body: current, startsChildBranch: false };
}

function groupedLineNumberGutter(body: string): { lineNo: string; width: number } | undefined {
	const visible = stripAnsi(body).replace(/^[\uE000\uE001]+/u, "");
	const match = visible.match(/^\s*(\d+)\s*│/u);
	return match?.[1] ? { lineNo: match[1], width: match[1].length } : undefined;
}

function normalizeGroupedLineNumberGutter(body: string, width: number): string {
	const gutter = groupedLineNumberGutter(body);
	if (!gutter) return body;
	const targetPadding = " ".repeat(Math.max(0, width - gutter.lineNo.length));
	let index = 0;
	while (index < body.length) {
		const code = body.charCodeAt(index);
		if (code === 0xe000 || code === 0xe001) {
			index++;
			continue;
		}
		const ansi = body.slice(index).match(/^\x1b\[[0-9;]*m/);
		if (ansi?.[0]) {
			index += ansi[0].length;
			continue;
		}
		break;
	}
	const prefixEnd = index;
	while (index < body.length && (body[index] === " " || body[index] === "\t")) index++;
	return `${body.slice(0, prefixEnd)}${targetPadding}${body.slice(index)}`;
}

function formatBranchedToolLines(lines: string[], index: number, total: number, width: number, status: ToolStatus): string[] {
	const output: string[] = [];
	const content = lines.filter((line) => isTerminalImageLine(line) || stripAnsi(line).trim().length > 0);
	const safeContent = content.length > 0 ? content : [""];
	const strippedLines = safeContent.map((line, lineIndex) => (
		lineIndex === 0 || isTerminalImageLine(line)
			? { body: line, startsChildBranch: false }
			: stripGroupedToolBodyIndent(line)
	));
	const gutterWidth = Math.max(0, ...strippedLines.map((line) => groupedLineNumberGutter(line.body)?.width ?? 0));
	const light = groupStatusLight(status);
	let sawChildBranch = false;
	for (let lineIndex = 0; lineIndex < safeContent.length; lineIndex++) {
		const line = safeContent[lineIndex];
		if (isTerminalImageLine(line)) {
			output.push(line);
			continue;
		}
		const prefix = lineIndex === 0 ? `${branchPrefix(index, total)}${light} ` : branchContinuation(index, total);
		const stripped = strippedLines[lineIndex] ?? { body: line, startsChildBranch: false };
		const body = gutterWidth > 0 ? normalizeGroupedLineNumberGutter(stripped.body, gutterWidth) : stripped.body;
		const childTextIndent = lineIndex > 0 && sawChildBranch && !stripped.startsChildBranch ? "   " : "";
		output.push(clampLineWidth(`${prefix}${childTextIndent}${body}`, width));
		if (stripped.startsChildBranch) sawChildBranch = true;
	}
	return output;
}

const NON_GROUPABLE_TOOL_NAMES = new Set(["edit", "write", "apply_patch"]);
const ACTIVE_TOOL_GROUPS = new Set<any>();

type ToolGroupRenderCache = {
	width: number;
	expanded: boolean;
	branchKey: string;
	branchEpoch: number;
	statusKey: string;
	lines: string[];
};

function isGroupableTool(value: unknown): value is InstanceType<typeof ToolExecutionComponent> {
	return value instanceof ToolExecutionComponent && !NON_GROUPABLE_TOOL_NAMES.has(getToolName(value));
}

class ToolGroupComponent extends Container {
	private tools: any[] = [];
	private expanded = false;
	private renderCache: ToolGroupRenderCache | undefined;

	clearRenderCache(): void {
		this.renderCache = undefined;
	}

	addTool(tool: any): void {
		ACTIVE_TOOL_GROUPS.add(this);
		this.clearRenderCache();
		this.tools.push(tool);
		tool[COMPONENT_PARENT] = this;
		this.invalidate();
	}

	releaseTools(): any[] {
		const tools = this.tools;
		this.tools = [];
		this.clearRenderCache();
		ACTIVE_TOOL_GROUPS.delete(this);
		return tools;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) this.clearRenderCache();
		this.expanded = expanded;
		for (const tool of this.tools) tool.setExpanded?.(expanded);
	}

	invalidate(): void {
		this.clearRenderCache();
		for (const tool of this.tools) tool.invalidate?.();
	}

	private statusKey(): string {
		return this.tools.map((tool) => `${getToolName(tool)}:${tool?.toolCallId ?? ""}:${getToolStatusForGroup(tool)}`).join("|");
	}

	render(width: number): string[] {
		if (this.tools.length === 0) return [];
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		const branchKey = toolBranchRenderCacheKey();
		const statusKey = this.statusKey();
		const hasPendingTool = statusKey.includes(":pending");
		const cached = this.renderCache;
		if (!hasPendingTool
			&& cached?.width === safeWidth
			&& cached?.expanded === this.expanded
			&& cached?.branchKey === branchKey
			&& cached?.branchEpoch === _toolBranchVisualEpoch
			&& cached?.statusKey === statusKey
		) {
			return cached.lines;
		}

		const groupedName = getGroupedToolName(this.tools);
		const label = getToolGroupLabel(this.tools);
		const names = groupedName ? "" : formatToolNameList(this.tools);
		const light = groupStatusLight(getToolGroupOverallStatus(this.tools));
		const summaryLabel = `${label}:`;
		const summary = ` ${light} ${summaryLabel} ${formatToolGroupCounts(this.tools)}${names ? ` ${TRANSPARENT_RESET}• ${names}` : ""}${toolOutputDetailHint(undefined as any, this.expanded, true)}`;
		const lines = [" ".repeat(safeWidth), clampLineWidth(summary, safeWidth)];
		const childWidth = Math.max(1, safeWidth - 6);

		this.tools.forEach((tool, index) => {
			const rawLines = this.expanded
				? getExpandedToolGroupLines(tool, childWidth, groupedName ? label : undefined)
				: [getCompactToolLine(tool, childWidth, groupedName ? label : undefined)];
			lines.push(...formatBranchedToolLines(rawLines, index, this.tools.length, safeWidth, getToolStatusForGroup(tool)));
		});

		const rendered = lines.map((line) => clampLineWidth(line, safeWidth));
		if (!hasPendingTool) {
			this.renderCache = { width: safeWidth, expanded: this.expanded, branchKey, branchEpoch: _toolBranchVisualEpoch, statusKey, lines: rendered };
		}
		return rendered;
	}
}

function isToolGroupComponent(value: unknown): value is ToolGroupComponent {
	return value instanceof ToolGroupComponent;
}

function isIgnorableToolSeparator(value: unknown): boolean {
	if (value instanceof Spacer) return true;
	if (value instanceof AssistantMessageComponent) {
		const contentChildren = (value as any).contentContainer?.children;
		return Array.isArray(contentChildren) && contentChildren.length === 0;
	}
	return false;
}

function findPreviousToolSibling(children: any[], startIndex: number): { child: any; index: number } | undefined {
	let skippedSeparators = 0;
	for (let index = startIndex; index >= 0; index--) {
		const child = children[index];
		if (isIgnorableToolSeparator(child) && skippedSeparators < 3) {
			skippedSeparators++;
			continue;
		}
		return { child, index };
	}
	return undefined;
}

function ungroupActiveToolGroups(): void {
	for (const group of [...ACTIVE_TOOL_GROUPS]) {
		const parent = group?.[COMPONENT_PARENT];
		const children = parent?.children;
		if (!Array.isArray(children)) {
			ACTIVE_TOOL_GROUPS.delete(group);
			continue;
		}
		const index = children.indexOf(group);
		if (index === -1) {
			ACTIVE_TOOL_GROUPS.delete(group);
			continue;
		}
		const tools = group.releaseTools();
		for (const tool of tools) tool[COMPONENT_PARENT] = parent;
		children.splice(index, 1, ...tools);
	}
}

function maybeGroupToolComponent(parent: any, component: any): void {
	if (!toolGroupingEnabled() || !isGroupableTool(component) || isToolGroupComponent(parent)) return;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index <= 0) return;
	const previousEntry = findPreviousToolSibling(children, index - 1);
	if (!previousEntry) return;
	const previous = previousEntry.child;
	if (isToolGroupComponent(previous)) {
		children.splice(index, 1);
		previous.addTool(component);
		return;
	}
	if (isGroupableTool(previous)) {
		const group = new ToolGroupComponent();
		group.setExpanded(Boolean((previous as any).expanded));
		group.addTool(previous);
		group.addTool(component);
		(group as any)[COMPONENT_PARENT] = parent;
		children[previousEntry.index] = group;
		children.splice(index, 1);
	}
}

function patchContainerParentTracking(): void {
	const proto = Container.prototype as any;
	if (proto[PARENT_TRACKING_PATCH_FLAG]) return;
	const originalAddChild = proto.addChild;
	const originalRemoveChild = proto.removeChild;
	const originalClear = proto.clear;
	proto.addChild = function patchedAddChild(component: any) {
		const result = originalAddChild.call(this, component);
		if (component && typeof component === "object") component[COMPONENT_PARENT] = this;
		maybeGroupToolComponent(this, component);
		return result;
	};
	proto.removeChild = function patchedRemoveChild(component: any) {
		const result = originalRemoveChild.call(this, component);
		if (component && typeof component === "object" && component[COMPONENT_PARENT] === this) delete component[COMPONENT_PARENT];
		return result;
	};
	proto.clear = function patchedClear() {
		for (const child of this.children ?? []) {
			if (child && typeof child === "object" && child[COMPONENT_PARENT] === this) delete child[COMPONENT_PARENT];
		}
		return originalClear.call(this);
	};
	proto[PARENT_TRACKING_PATCH_FLAG] = true;
}

function patchGlobalToolBorders(): void {
	const proto = Container.prototype as any;
	if (proto[PATCH_FLAG]) return;

	const originalRender = proto.render;
	proto.render = function patchedContainerRender(width: number): string[] {
		if (isToolExecutionLike(this)) {
			const cached = (this as any)[TOOL_RENDER_CACHE];
			const branchKey = toolBranchRenderCacheKey();
			if (
				cached?.width === width
				&& cached?.mode === toolBackgroundMode
				&& cached?.branchKey === branchKey
				&& cached?.branchEpoch === _toolBranchVisualEpoch
			) {
				return cached.lines;
			}
		}

		const rendered = originalRender.call(this, width);
		if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
		if (!isToolExecutionLike(this)) return rendered;
		const branchCache = { branchKey: toolBranchRenderCacheKey(), branchEpoch: _toolBranchVisualEpoch };
		if (toolBackgroundMode === "default") {
			(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: rendered, ...branchCache };
			return rendered;
		}

		let start = 0;
		while (start < rendered.length && isBlankLine(rendered[start])) start++;
		let end = rendered.length - 1;
		while (end >= start && isBlankLine(rendered[end])) end--;
		if (start > end) return rendered;

		const { textLines, imageLines } = splitRenderedImageBlock(rendered.slice(start, end + 1));
		if (imageLines.length > 0) {
			(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: rendered, ...branchCache };
			return rendered;
		}
		const indentTool = shouldIndentToolExecution(this);
		const core = textLines.map((line) => {
			const normalized = normalizeLeadingCheckGlyph(line);
			return clampLineWidth(indentTool && normalized ? ` ${normalized}` : normalized, width);
		});
		const spacerLine = " ".repeat(width);
		let result: string[];

		if (toolBackgroundMode === "outlines") {
			const ruleWidth = Math.max(1, width);
			const framed = core.length > 0 ? [borderLine(ruleWidth), ...core, borderLine(ruleWidth)] : [];
			result = [spacerLine, ...framed, ...imageLines];
		} else {
			result = [spacerLine, ...core, ...imageLines];
		}

		(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: result, ...branchCache };
		return result;
	};

	proto[PATCH_FLAG] = true;
}

function summarizeText(text: string, max = 60): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}

function hashText(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function configuredKeyHint(binding: Parameters<typeof keyText>[0], fallbackKey: string, description: string): string {
	try {
		if (keyText(binding).trim()) return keyHint(binding, description);
	} catch { /* fall back below */ }
	return rawKeyHint(fallbackKey, description);
}

function expandHint(_theme: Theme, action: "expand" | "collapse" | "toggle" = "toggle"): string {
	return ` • ${configuredKeyHint("app.tools.expand", "ctrl+o", `to ${action}`)}`;
}

function toolOutputDetailHint(theme: Theme, expanded: boolean, hasMore = false): string {
	if (!expanded) return expandHint(theme, "expand");
	const parts = [expandHint(theme, "collapse")];
	return parts.join("");
}

function clearStateKeys(state: Record<string, unknown> | undefined, ...keys: string[]): void {
	if (!state) return;
	for (const key of keys) {
		delete state[key];
	}
}

function clearToolRenderCache(value: unknown): void {
	if (!value || typeof value !== "object") return;
	delete (value as any)[TOOL_RENDER_CACHE];
	const parent = (value as any)[COMPONENT_PARENT];
	if (parent && typeof parent.clearRenderCache === "function") {
		try { parent.clearRenderCache(); } catch { /* noop */ }
	}
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | null | undefined): void {
	(timer as any)?.unref?.();
}

function safeInvalidate(ctx: any): void {
	try {
		if (typeof ctx?.invalidate === "function") ctx.invalidate();
	} catch {
		// Tool render contexts may outlive their row during reload/session switches.
	}
}

const ASSISTANT_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-assistant-message");
const ASSISTANT_RENDER_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-assistant-message-render");
const TOOL_EXECUTION_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-execution");
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const WORKED_DURATION_KEY = "_piClaudeStyleWorkedDurationMs";
const THINKING_DURATION_KEY = "_piClaudeStyleThinkingDurationMs";
const THINKING_ACTIVE_KEY = "_piClaudeStyleThinkingActive";
const WORKED_START_KEY = "_piClaudeStyleWorkedStartMs";
const WORKED_DURATION_MARKER = "Worked for";
const MIN_THINKING_SUMMARY_MS = 100;

let lastThinkingBlockDurationMs: number | undefined;
let thinkingBlockStartMs = 0;
/** True from thinking_start until thinking_end on the current assistant stream. */
let thinkingBlockInFlight = false;
// WORKED_LINE_FG is theme-derived (from "muted") when themeAdaptive is on.
let WORKED_LINE_FG = "\x1b[38;2;140;140;140m";
let currentAgentWorkStartMs: number | undefined;
let currentAssistantMessageStartMs: number | undefined;

function formatWorkedDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (safeMs < 60_000) {
		return `${Math.max(0, Math.floor(safeMs / 1000))}s`;
	}
	let days = Math.floor(safeMs / 86_400_000);
	let hours = Math.floor((safeMs % 86_400_000) / 3_600_000);
	let minutes = Math.floor((safeMs % 3_600_000) / 60_000);
	let seconds = Math.round((safeMs % 60_000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	if (minutes === 60) {
		minutes = 0;
		hours++;
	}
	if (hours === 24) {
		hours = 0;
		days++;
	}
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

function formatThoughtDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (safeMs < 60_000) return `${Math.max(1, Math.round(safeMs / 1000))}s`;
	return formatWorkedDuration(safeMs);
}

const THINKING_ITALIC = "\x1b[3m";

function thinkingSummaryStyledText(body: string): string {
	return ` ${WORKED_LINE_FG}${THINKING_ITALIC}✻ ${body}${RESET}`;
}

function thinkingActiveSummaryText(): string {
	return thinkingSummaryStyledText("Thinking…");
}

function thoughtDurationSummaryText(ms: number): string {
	return thinkingSummaryStyledText(`Thought for ${formatThoughtDuration(ms)}`);
}

/** Single-line hidden thinking row — no Text paddingX, full muted italic styling. */
class HiddenThinkingSummary {
	private summaryText: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(summaryText: string) {
		this.summaryText = summaryText;
	}

	setSummary(summaryText: string): void {
		this.summaryText = summaryText;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) {
			this.cachedWidth = width;
			this.cachedLines = [""];
			return this.cachedLines;
		}
		const line = padRenderedLineToWidth(this.summaryText, safeWidth);
		this.cachedWidth = width;
		this.cachedLines = [line];
		return this.cachedLines;
	}
}

function assistantMessageThinkingComplete(message: any): boolean {
	// toolUse is an intermediate assistant chunk — thinking may still be in progress on the next chunk.
	const reason = message?.stopReason;
	if (reason === "toolUse") return false;
	return typeof reason === "string" && reason.length > 0;
}

function hiddenThinkingSummaryForMessage(message: any): string {
	// Per-message flags win over globals so a late render pass cannot keep
	// "Thinking…" after thinking_end already stored duration on this message.
	if ((message as any)?.[THINKING_ACTIVE_KEY]) return thinkingActiveSummaryText();
	const stored = (message as any)?.[THINKING_DURATION_KEY];
	const durationMs = typeof stored === "number"
		? stored
		: assistantMessageThinkingComplete(message) && typeof lastThinkingBlockDurationMs === "number"
			? lastThinkingBlockDurationMs
			: undefined;
	if (typeof durationMs === "number" && durationMs >= MIN_THINKING_SUMMARY_MS) {
		return thoughtDurationSummaryText(durationMs);
	}
	if (thinkingBlockInFlight) return thinkingActiveSummaryText();
	return thinkingActiveSummaryText();
}

function isHiddenThinkingPlaceholderText(child: unknown): child is InstanceType<typeof Text> {
	if (!(child instanceof Text)) return false;
	const plain = stripAnsi(String((child as any).text ?? "")).trim();
	if (/^✻\s*Thinking/i.test(plain)) return true;
	if (/^✻\s*Thought for/i.test(plain)) return true;
	if (/^Thinking\.\.\.$/i.test(plain)) return true;
	if (/^Thinking…$/i.test(plain)) return true;
	return /^Thinking:?\s*$/i.test(plain);
}

function messageHasThinkingContent(message: any): boolean {
	return Array.isArray(message?.content)
		&& message.content.some((block: any) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim());
}

function workedDurationText(ms: number): string {
	return `${WORKED_LINE_FG}✻ Worked for ${formatWorkedDuration(ms)}${RESET}`;
}

function inlineWorkedDurationText(ms: number): string {
	return `${WORKED_LINE_FG}✻ Worked for ${formatWorkedDuration(ms)}${RESET}`;
}

function isWorkedDurationLine(line: string): boolean {
	return line.includes(WORKED_DURATION_MARKER) && /^✻ Worked for [^\r\n]+$/.test(stripAnsi(line).trim());
}

function stripWorkedDurationLine(text: string): string {
	if (!text.includes(WORKED_DURATION_MARKER)) return text;
	return text
		.split(/\r?\n/)
		.filter((line) => !isWorkedDurationLine(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

function hasWorkedDurationLine(message: any): boolean {
	if (!Array.isArray(message?.content)) return false;
	return message.content.some((block: any) => {
		if (block?.type !== "text" || typeof block.text !== "string" || !block.text.includes(WORKED_DURATION_MARKER)) return false;
		return block.text.split(/\r?\n/).some(isWorkedDurationLine);
	});
}

function appendWorkedDurationLine(message: any, durationMs: number): void {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
	const textBlocks = message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
	const lastText = textBlocks[textBlocks.length - 1];
	if (!lastText) return;
	const text = lastText.text.includes(WORKED_DURATION_MARKER) ? stripWorkedDurationLine(lastText.text) : lastText.text;
	lastText.text = `${text.trimEnd()}\n\n${inlineWorkedDurationText(durationMs)}`;
}

function replaceHiddenThinkingPlaceholders(container: { children?: any[] }, message: any): void {
	if (!container?.children) return;
	const summary = hiddenThinkingSummaryForMessage(message);
	for (let i = 0; i < container.children.length; i++) {
		const child = container.children[i];
		if (child instanceof HiddenThinkingSummary) {
			child.setSummary(summary);
			continue;
		}
		if (isHiddenThinkingPlaceholderText(child)) {
			container.children[i] = new HiddenThinkingSummary(summary);
		}
	}
}

function trimRenderedBlankLines(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankLine(lines[start])) start++;
	let end = lines.length - 1;
	while (end >= start && isBlankLine(lines[end])) end--;
	return start <= end ? lines.slice(start, end + 1) : [];
}

function isSubagentNotificationMessage(message: unknown): boolean {
	const candidate = message as Record<string, unknown> | undefined;
	return candidate?.customType === "subagent-notification";
}

function isSubagentHeaderLine(line: string): boolean {
	return /^[✓✔✗■●]\s+/.test(stripAnsi(line).trimStart());
}

function isSubagentDetailLine(line: string): boolean {
	const plain = stripAnsi(line).trimStart();
	return plain.startsWith("⎿")
		|| plain.startsWith("transcript:")
		|| plain === "No output."
		|| /^(?:Done|Wrapped up|Stopped|Error:|Aborted)\b/.test(plain);
}

function cleanSubagentDetailLine(line: string): string {
	const markerIndex = line.indexOf("⎿");
	if (markerIndex !== -1) {
		const prefixAnsi = (line.slice(0, markerIndex).match(ANSI_RE) ?? []).join("");
		return `${prefixAnsi}${line.slice(markerIndex + 1).replace(/^\s+/, "")}`;
	}
	return line
		.replace(/^((?:\x1b\[[0-9;]*m)*)\s{2}/, "$1")
		.replace(/^\s{2}/, "");
}

function formatSubagentNotificationGroup(lines: string[]): string[] {
	if (lines.length === 0) return [];
	const header = normalizeLeadingCheckGlyph(lines[0]);
	const rest = lines.slice(1);
	const detailStart = rest.findIndex(isSubagentDetailLine);
	if (detailStart === -1) {
		return [header, ...rest];
	}

	const metadata = rest.slice(0, detailStart);
	const detailLines = rest.slice(detailStart).map(cleanSubagentDetailLine).filter((line) => stripAnsi(line).trim().length > 0);
	const formattedDetails = withFinalBranchBlock(detailLines.join("\n"), undefined as any).split("\n").filter((line) => line.length > 0);
	return [header, ...metadata, ...formattedDetails];
}

function splitSubagentNotificationGroups(lines: string[]): string[][] {
	const groups: string[][] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (isSubagentHeaderLine(line) && current.length > 0) {
			groups.push(current);
			current = [line];
		} else {
			current.push(line);
		}
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

function frameToolLikeLines(lines: string[], width: number): string[] {
	syncToolBackgroundMode();
	const safeWidth = Math.max(1, width);
	const core = trimRenderedBlankLines(lines).map((line) => clampLineWidth(line, safeWidth));
	if (core.length === 0 || toolBackgroundMode === "default") return core;
	const spacerLine = " ".repeat(safeWidth);
	if (toolBackgroundMode === "outlines") {
		return [spacerLine, borderLine(safeWidth), ...core, borderLine(safeWidth)];
	}
	return [spacerLine, ...core];
}

function formatSubagentNotification(lines: string[], width: number): string[] {
	const core = trimRenderedBlankLines(lines).map(normalizeLeadingCheckGlyph);
	if (core.length === 0) return lines;
	const formatted = splitSubagentNotificationGroups(core).flatMap((group, index) => {
		const groupLines = formatSubagentNotificationGroup(group);
		return index === 0 ? groupLines : ["", ...groupLines];
	});
	const indented = formatted.map((line) => (line ? ` ${line}` : line));
	return frameToolLikeLines(indented, width);
}

function patchCustomMessageRender(): void {
	const proto = CustomMessageComponent.prototype as any;
	if (proto[CUSTOM_MESSAGE_PATCH_FLAG]) return;
	const originalRender = proto.render;
	if (typeof originalRender !== "function") return;
	proto.render = function patchedCustomMessageRender(width: number) {
		const lines = originalRender.call(this, width);
		if (!Array.isArray(lines)) return lines;
		if (isSubagentNotificationMessage(this?.message)) {
			return formatSubagentNotification(lines, width);
		}
		return lines.map(normalizeLeadingCheckGlyph);
	};
	proto[CUSTOM_MESSAGE_PATCH_FLAG] = true;
}

function stripOsc133Zones(line: string): string {
	return line
		.replace(OSC133_ZONE_START, "")
		.replace(OSC133_ZONE_END, "")
		.replace(OSC133_ZONE_FINAL, "");
}

function stripBackgroundAnsi(text: string): string {
	return text.replace(/\x1b\[([0-9;]*)m/g, (match, paramsText: string) => {
		const params = paramsText === "" ? ["0"] : paramsText.split(";");
		const kept: string[] = [];
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i] || "0");
			if (code === 48) {
				const mode = Number(params[i + 1] || "0");
				i += mode === 2 ? 4 : mode === 5 ? 2 : 0;
				continue;
			}
			if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) continue;
			kept.push(params[i]);
		}
		return kept.length === 0 ? "" : `\x1b[${kept.join(";")}m`;
	});
}

function roundedUserBorder(width: number, top: boolean): string {
	if (width <= 1) return `${BORDER_COLOR}│${TRANSPARENT_RESET}`;
	const left = top ? "╭" : "╰";
	const right = top ? "╮" : "╯";
	if (!top || width < 10) {
		return `${BORDER_COLOR}${left}${"─".repeat(Math.max(0, width - 2))}${right}${TRANSPARENT_RESET}`;
	}
	const label = `${WORKED_LINE_FG} User ${TRANSPARENT_RESET}`;
	const prefix = "─";
	const suffixWidth = Math.max(0, width - 2 - visibleWidth(prefix) - visibleWidth(label));
	return `${BORDER_COLOR}${left}${prefix}${TRANSPARENT_RESET}${label}${BORDER_COLOR}${"─".repeat(suffixWidth)}${right}${TRANSPARENT_RESET}`;
}

function trimAnsiRight(text: string): string {
	let trimmed = text;
	while (true) {
		const next = trimmed.replace(/[ \t]+((?:\x1b\[[0-9;]*m)*)$/g, "$1");
		if (next === trimmed) return trimmed;
		trimmed = next;
	}
}

function cleanUserMessageLine(line: string): string {
	return `${TRANSPARENT_BG}${trimAnsiRight(stripBackgroundAnsi(stripOsc133Zones(line)))}${TRANSPARENT_BG}`;
}

function borderedUserMessageLine(line: string, width: number): string {
	const innerWidth = Math.max(1, width - 4);
	const content = clampLineWidth(cleanUserMessageLine(line), innerWidth);
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
	return `${BORDER_COLOR}│${TRANSPARENT_RESET} ${content}${padding} ${BORDER_COLOR}│${TRANSPARENT_RESET}`;
}

function visitMarkdownDescendants(root: unknown, visit: (md: InstanceType<typeof Markdown>) => void): void {
	if (!root || typeof root !== "object") return;
	const node = root as { children?: unknown[] };
	for (const child of node.children ?? []) {
		if (child instanceof Markdown) visit(child);
		else visitMarkdownDescendants(child, visit);
	}
}

function patchUserMessageRender(): void {
	const proto = UserMessageComponent.prototype as any;
	if (proto[USER_MESSAGE_PATCH_FLAG]) return;
	const originalRender = proto.render;
	if (typeof originalRender !== "function") return;
	proto.render = function patchedUserMessageRender(width: number) {
		visitMarkdownDescendants(this, (child) => {
			const markdownAny = child as any;
			makeMarkdownLinksCopySafe(child);
			if (markdownAny.defaultTextStyle?.bgColor) {
				markdownAny.defaultTextStyle.bgColor = undefined;
				child.invalidate?.();
			}
		});
		const borderWidth = Math.max(1, width);
		const contentWidth = Math.max(1, borderWidth - 4);
		const lines = originalRender.call(this, contentWidth);
		if (!Array.isArray(lines) || lines.length === 0) return lines;
		const rendered = [
			roundedUserBorder(borderWidth, true),
			...lines.map((line: string) => borderedUserMessageLine(line, borderWidth)),
			roundedUserBorder(borderWidth, false),
		];
		const clamped = rendered.map((line) => clampLineWidth(line, borderWidth));
		return applyTerminalCopyZones(clamped);
	};
	proto[USER_MESSAGE_PATCH_FLAG] = true;
}

function patchAssistantMessages(): void {
	const proto = AssistantMessageComponent.prototype as any;
	if (proto[ASSISTANT_PATCH_FLAG]) return;
	const originalRender = proto.render;
	if (typeof originalRender === "function" && !proto[ASSISTANT_RENDER_PATCH_FLAG]) {
		proto.render = function patchedAssistantMessageRender(width: number) {
			const lines = originalRender.call(this, width);
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			if ((this as any).hasToolCalls) return lines;
			return applyTerminalCopyZones(lines);
		};
		proto[ASSISTANT_RENDER_PATCH_FLAG] = true;
	}
	const originalUpdateContent = proto.updateContent;
	proto.updateContent = function patchedUpdateContent(message: any) {
		if (!(this as any)[WORKED_START_KEY]) {
			(this as any)[WORKED_START_KEY] = Date.now();
		}
		if (!message || !Array.isArray(message.content)) {
			return originalUpdateContent.call(this, message);
		}
		if ((this as any).hideThinkingBlock && messageHasThinkingContent(message)) {
			// Pi wraps this in theme.italic/fg again — keep plain label for the placeholder pass.
			(this as any).hiddenThinkingLabel = "Thinking…";
		}
		// Call original to build all children (text, thinking, spacers, errors)
		originalUpdateContent.call(this, message);
		// Replace text-block Markdown children with DottedParagraph wrappers
		const container = (this as any).contentContainer;
		if (!container?.children) return;
		if ((this as any).hideThinkingBlock && messageHasThinkingContent(message)) {
			replaceHiddenThinkingPlaceholders(container, message);
		}
		const mdTheme = (this as any).markdownTheme;
		for (let i = container.children.length - 1; i >= 0; i--) {
			const child = container.children[i];
			if (child instanceof Markdown) {
				const text = (child as any).text;
				if (!text) continue;
				const isThinking = !!(child as any).defaultTextStyle?.italic;
				if (isThinking) {
					const style = (child as any).defaultTextStyle;
					container.children[i] = new ThinkingParagraph(text, mdTheme, style);
				} else {
					container.children[i] = new DottedParagraph(text, mdTheme);
				}
			}
		}
		const explicitDuration = (message as any)[WORKED_DURATION_KEY];
		const componentStart = (this as any)[WORKED_START_KEY];
		const isFinished = typeof message.stopReason === "string" && message.stopReason.length > 0;
		const isFinalAssistantMessage = isFinished && message.stopReason !== "toolUse";
		const fallbackStart = typeof currentAgentWorkStartMs === "number" ? currentAgentWorkStartMs : componentStart;
		const workedDuration = typeof explicitDuration === "number"
			? explicitDuration
			: isFinalAssistantMessage && typeof fallbackStart === "number"
				? Date.now() - fallbackStart
				: undefined;
		const hasAssistantText = message.content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
		if (typeof workedDuration === "number" && isFinalAssistantMessage && hasAssistantText && !hasWorkedDurationLine(message)) {
			container.children.push(new Spacer(1), new Text(workedDurationText(workedDuration), 1, 0));
		}
	};
	proto[ASSISTANT_PATCH_FLAG] = true;
}

const TOOL_BG_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-bg-sync");

function patchToolExecutionBackgroundSync(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_BG_PATCH_FLAG]) return;
	const originalUpdateDisplay = proto.updateDisplay;
	if (typeof originalUpdateDisplay !== "function") return;
	proto.updateDisplay = function patchedToolBackgroundSync(this: any) {
		syncToolBackgroundMode();
		applyToolBackgroundMode(getGlobalPiTheme());
		return originalUpdateDisplay.apply(this, arguments as any);
	};
	proto[TOOL_BG_PATCH_FLAG] = true;
}

function patchToolRenderCacheInvalidation(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_CACHE_PATCH_FLAG]) return;

	const methods = [
		"updateDisplay",
		"updateArgs",
		"markExecutionStarted",
		"setArgsComplete",
		"updateResult",
		"setExpanded",
		"setShowImages",
		"setImageWidthCells",
		"invalidate",
	];

	for (const method of methods) {
		const original = proto[method];
		if (typeof original !== "function") continue;
		proto[method] = function patchedToolMutation(...args: any[]) {
			clearToolRenderCache(this);
			const result = original.apply(this, args);
			clearToolRenderCache(this);
			return result;
		};
	}

	proto[TOOL_CACHE_PATCH_FLAG] = true;
}

function deleteRenderedKittyImages(component: any): void {
	if (!process.stdout.isTTY || getCapabilities().images !== "kitty" || !Array.isArray(component.imageComponents) || component.imageComponents.length === 0) return;
	try { process.stdout.write(deleteAllKittyImages()); } catch { /* noop */ }
}

function removeImageChildren(component: any): void {
	deleteRenderedKittyImages(component);
	const children = [
		...(Array.isArray(component.imageComponents) ? component.imageComponents : []),
		...(Array.isArray(component.imageSpacers) ? component.imageSpacers : []),
	];
	for (const child of children) {
		try { component.removeChild?.(child); } catch { /* noop */ }
	}
	component.imageComponents = [];
	component.imageSpacers = [];
}

function patchReadImageExpansion(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_IMAGE_EXPAND_PATCH_FLAG]) return;
	const originalUpdateDisplay = proto.updateDisplay;
	if (typeof originalUpdateDisplay !== "function") return;
	proto.updateDisplay = function patchedReadImageUpdateDisplay(...args: any[]) {
		const result = originalUpdateDisplay.apply(this, args);
		const hasImage = Array.isArray(this.result?.content) && this.result.content.some((block: any) => block?.type === "image");
		if (this.toolName === "read" && hasImage && this.expanded !== true) {
			removeImageChildren(this);
			clearToolRenderCache(this);
		}
		return result;
	};
	proto[TOOL_IMAGE_EXPAND_PATCH_FLAG] = true;
}

function patchToolExecutionRenderers(): void {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_EXECUTION_PATCH_FLAG]) return;

	const originalHasRendererDefinition = proto.hasRendererDefinition;
	const originalGetCallRenderer = proto.getCallRenderer;
	const originalGetResultRenderer = proto.getResultRenderer;

	if (typeof originalHasRendererDefinition === "function") {
		proto.hasRendererDefinition = function patchedHasRendererDefinition() {
			return originalHasRendererDefinition.call(this) || shouldUseGenericToolRenderer(this?.toolName);
		};
	}

	proto.getCallRenderer = function patchedGetCallRenderer() {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (toolName === "apply_patch") {
			return (args: any, theme: Theme, ctx: any) =>
				renderApplyPatchCall(args, theme, ctx, (path: string) => shortPath(ctx.cwd ?? process.cwd(), path));
		}
		if (shouldUseGenericToolRenderer(toolName)) {
			return (args: any, theme: Theme, ctx: any) => renderGenericToolCall(toolName, args, theme, ctx);
		}
		return typeof originalGetCallRenderer === "function" ? originalGetCallRenderer.call(this) : undefined;
	};

	proto.getResultRenderer = function patchedGetResultRenderer() {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (toolName === "apply_patch") {
			return (result: any, options: any, theme: Theme, ctx: any) =>
				renderApplyPatchResult({ content: result.content, details: result.details }, options.isPartial, theme, ctx);
		}
		if (shouldUseGenericToolRenderer(toolName)) {
			return (result: any, options: any, theme: Theme, ctx: any) =>
				renderGenericToolResult(toolName, result, options, theme, ctx);
		}
		return typeof originalGetResultRenderer === "function" ? originalGetResultRenderer.call(this) : undefined;
	};

	proto[TOOL_EXECUTION_PATCH_FLAG] = true;
}

function shortPath(cwd: string, filePath: string): string {
	if (!filePath) return "";
	const rel = relative(cwd, filePath);
	if (!rel.startsWith("..") && !rel.startsWith("/")) return rel || ".";
	const home = process.env.HOME ?? "";
	return home ? filePath.replace(home, "~") : filePath;
}

// ---------------------------------------------------------------------------
// Status dot — flickers green/gray while pending
// ---------------------------------------------------------------------------

function isBlinkOn(): boolean {
	return Math.floor(Date.now() / 500) % 2 === 0;
}

function toolHeader(tool: string, summary: string, theme: Theme, prefix = ""): string {
	applyThemePaletteIfNeeded(theme);
	const label = theme.fg("toolTitle", theme.bold(tool));
	if (!summary) return `${prefix}${label}`;
	return `${prefix}${label} ${WRAP_MARK}${theme.fg("accent", summary)}`;
}

function setToolStatus(ctx: any, status: "pending" | "success" | "error"): void {
	ctx.state._toolStatus = status;
}

function syncToolCallStatus(ctx: any): void {
	if (!ctx?.executionStarted || ctx?.isPartial) {
		setToolStatus(ctx, "pending");
		return;
	}
	setToolStatus(ctx, ctx.isError ? "error" : "success");
}

function shouldRevealCallArgs(ctx: any): boolean {
	if (ctx?.argsComplete === true || ctx?.executionStarted === true) return true;
	const args = ctx?.args;
	if (!args || typeof args !== "object") return false;
	return Object.keys(args).some((key) => args[key] !== undefined && args[key] !== null && args[key] !== "");
}

function stableCallSummary(ctx: any, key: string, build: () => string, reveal = shouldRevealCallArgs(ctx)): string {
	const state = ctx?.state;
	const cached = state?.[key];
	const completeKey = `${key}Complete`;
	if (!reveal) return typeof cached === "string" ? cached : "";
	if (ctx?.argsComplete === true && state?.[completeKey] === true && typeof cached === "string") return cached;
	if (!shouldRevealCallArgs(ctx) && typeof cached === "string" && cached) return cached;
	const summary = build();
	if (state) {
		state[key] = summary;
		if (ctx?.argsComplete === true) state[completeKey] = true;
		else delete state[completeKey];
	}
	return summary;
}

function hasOwnArg(args: any, key: string): boolean {
	return !!args && Object.prototype.hasOwnProperty.call(args, key);
}

function firstNonEmptyString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
}

function toolPathArg(args: any): string {
	return firstNonEmptyString(args?.path, args?.file_path);
}

function fileExistsForTool(cwd: string, filePath: string): boolean {
	if (!filePath) return false;
	try {
		return existsSync(resolve(cwd, filePath));
	} catch {
		return false;
	}
}

interface RtkRewriteRecord {
	original: string;
	rewritten: string;
	notice: string;
}

const RTK_ORIGINAL_BASH_COMMANDS = new Map<string, string>();
const RTK_ORIGINAL_TOOL_PREVIEWS = new Map<string, string>();
const RTK_ORIGINAL_TOOL_PREVIEW_ALIASES = new Map<string, string[]>();
const RTK_REWRITES_BY_TOOL_ID = new Map<string, RtkRewriteRecord>();
const RTK_PENDING_REWRITES: RtkRewriteRecord[] = [];
const RTK_PENDING_REWRITE_LIMIT = 20;
const PRESERVED_BASH_PREVIEWS = new Set<string>();
const BASH_PREVIEW_INVALIDATORS = new Map<string, () => void>();

function preserveBashPreview(ctx: any): void {
	const toolCallId = typeof ctx?.toolCallId === "string" ? ctx.toolCallId : undefined;
	if (!toolCallId) return;
	PRESERVED_BASH_PREVIEWS.add(toolCallId);
	if (typeof ctx?.invalidate === "function") {
		BASH_PREVIEW_INVALIDATORS.set(toolCallId, () => safeInvalidate(ctx));
	}
}

function clearPreservedBashPreviews(): void {
	if (PRESERVED_BASH_PREVIEWS.size === 0) return;
	const invalidators = [...PRESERVED_BASH_PREVIEWS]
		.map((toolCallId) => BASH_PREVIEW_INVALIDATORS.get(toolCallId))
		.filter((invalidate): invalidate is () => void => typeof invalidate === "function");
	PRESERVED_BASH_PREVIEWS.clear();
	BASH_PREVIEW_INVALIDATORS.clear();
	for (const invalidate of invalidators) {
		try { invalidate(); } catch { /* noop */ }
	}
}

function shouldPreserveBashPreview(ctx: any): boolean {
	return typeof ctx?.toolCallId === "string" && PRESERVED_BASH_PREVIEWS.has(ctx.toolCallId);
}

function normalizeRtkCommandPreview(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function rtkPreviewMatches(command: string, preview: string): boolean {
	const normalized = normalizeRtkCommandPreview(command);
	const normalizedPreview = normalizeRtkCommandPreview(preview);
	if (!normalized || !normalizedPreview) return false;
	if (normalized === normalizedPreview) return true;
	if (normalizedPreview.endsWith("…")) {
		return normalized.startsWith(normalizedPreview.slice(0, -1));
	}
	return normalized.startsWith(normalizedPreview) || normalizedPreview.startsWith(normalized);
}

function parseRtkRewriteNotice(message: string): RtkRewriteRecord | undefined {
	const match = message.match(/\bRTK rewrite:\s*(.*?)\s*->\s*(.+)$/is);
	if (!match) return undefined;
	const original = match[1]?.trim() ?? "";
	const rewritten = match[2]?.trim() ?? "";
	if (!original || !rewritten) return undefined;
	return { original, rewritten, notice: message };
}

function rememberPendingRtkRewrite(record: RtkRewriteRecord): void {
	RTK_PENDING_REWRITES.push(record);
	while (RTK_PENDING_REWRITES.length > RTK_PENDING_REWRITE_LIMIT) RTK_PENDING_REWRITES.shift();
}

function getRtkOriginalAliases(toolCallId: string): string[] {
	const aliases = RTK_ORIGINAL_TOOL_PREVIEW_ALIASES.get(toolCallId) ?? [];
	const preview = RTK_ORIGINAL_TOOL_PREVIEWS.get(toolCallId);
	const bash = RTK_ORIGINAL_BASH_COMMANDS.get(toolCallId);
	return [...new Set([preview, bash, ...aliases].filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function findRtkRewriteToolId(record: RtkRewriteRecord): string | undefined {
	const toolIds = [...new Set([
		...[...RTK_ORIGINAL_TOOL_PREVIEWS.keys()].reverse(),
		...[...RTK_ORIGINAL_TOOL_PREVIEW_ALIASES.keys()].reverse(),
		...[...RTK_ORIGINAL_BASH_COMMANDS.keys()].reverse(),
	])];
	return toolIds.find((toolCallId) => getRtkOriginalAliases(toolCallId).some((preview) => rtkPreviewMatches(preview, record.original)));
}

function rememberRtkRewrite(record: RtkRewriteRecord): void {
	const toolCallId = findRtkRewriteToolId(record);
	if (toolCallId) {
		RTK_REWRITES_BY_TOOL_ID.set(toolCallId, record);
		return;
	}
	rememberPendingRtkRewrite(record);
}

function takePendingRtkRewrite(originalCommand: string | undefined, currentCommand: string | undefined): RtkRewriteRecord | undefined {
	const index = RTK_PENDING_REWRITES.findIndex((record) => {
		return (!!originalCommand && rtkPreviewMatches(originalCommand, record.original))
			|| (!!currentCommand && (rtkPreviewMatches(currentCommand, record.rewritten) || rtkPreviewMatches(currentCommand, record.original)));
	});
	if (index === -1) return undefined;
	const [record] = RTK_PENDING_REWRITES.splice(index, 1);
	return record;
}

function ensureRtkRewriteForContext(ctx: any, args: any, currentPreview?: string): RtkRewriteRecord | undefined {
	if (ctx?.state?._rtkRewriteRecord) return ctx.state._rtkRewriteRecord as RtkRewriteRecord;
	const toolCallId = typeof ctx?.toolCallId === "string" ? ctx.toolCallId : undefined;
	const currentCommand = typeof args?.command === "string" ? args.command : currentPreview;
	const originalAliases = toolCallId ? getRtkOriginalAliases(toolCallId) : [];
	const originalCommand = originalAliases[0];
	if (!toolCallId) return undefined;

	let record = RTK_REWRITES_BY_TOOL_ID.get(toolCallId);
	if (!record) {
		record = takePendingRtkRewrite(originalAliases.find((alias) => RTK_PENDING_REWRITES.some((pending) => rtkPreviewMatches(alias, pending.original))), currentCommand);
		if (record) RTK_REWRITES_BY_TOOL_ID.set(toolCallId, record);
	}
	if (!record && originalCommand && currentCommand && normalizeRtkCommandPreview(originalCommand) !== normalizeRtkCommandPreview(currentCommand)) {
		record = {
			original: originalCommand,
			rewritten: currentCommand,
			notice: `RTK rewrite: ${originalCommand} -> ${currentCommand}`,
		};
		RTK_REWRITES_BY_TOOL_ID.set(toolCallId, record);
	}
	if (record && ctx?.state) ctx.state._rtkRewriteRecord = record;
	return record;
}

function formatRtkRewriteDetails(record: RtkRewriteRecord, theme: Theme): string {
	return [
		theme.fg("muted", "RTK rewrite"),
		`${theme.fg("muted", "original :")} ${theme.fg("dim", record.original)}`,
		`${theme.fg("muted", "rewritten:")} ${theme.fg("dim", record.rewritten)}`,
	].join("\n");
}

function getRtkCompaction(details: any): any | undefined {
	const direct = details?.rtkCompaction;
	const nested = details?.metadata?.rtkCompaction;
	const value = direct ?? nested;
	return value && typeof value === "object" && value.applied === true ? value : undefined;
}

function formatRtkCompactionDetails(compaction: any, theme: Theme): string {
	const originalLines = typeof compaction.originalLineCount === "number" ? compaction.originalLineCount : undefined;
	const compactedLines = typeof compaction.compactedLineCount === "number" ? compaction.compactedLineCount : undefined;
	const originalChars = typeof compaction.originalCharCount === "number" ? compaction.originalCharCount : undefined;
	const compactedChars = typeof compaction.compactedCharCount === "number" ? compaction.compactedCharCount : undefined;
	const parts = [`${theme.fg("muted", "RTK compacted")}`];
	if (originalLines !== undefined && compactedLines !== undefined) parts.push(`${theme.fg("muted", "lines:")} ${theme.fg("dim", `${originalLines} → ${compactedLines}`)}`);
	if (originalChars !== undefined && compactedChars !== undefined) parts.push(`${theme.fg("muted", "chars:")} ${theme.fg("dim", `${originalChars} → ${compactedChars}`)}`);
	return parts.join(theme.fg("dim", " · "));
}

function getGrepGroupedSummary(lines: string[]): { count: number; files?: number; header?: string } {
	const groupedHeader = lines.find((line) => /^\d+ matches in \d+ files?:/.test(line.trim()));
	if (groupedHeader) {
		const match = groupedHeader.trim().match(/^(\d+) matches in (\d+) files?:/);
		if (match) {
			return { count: Number.parseInt(match[1] ?? "0", 10), files: Number.parseInt(match[2] ?? "0", 10), header: groupedHeader };
		}
	}
	return { count: lines.length };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightGrepMatch(content: string, args: any, theme: Theme): string {
	const pattern = typeof args?.pattern === "string" ? args.pattern : "";
	if (!pattern) return theme.fg("dim", content || " ");
	try {
		const source = args?.literal === true ? escapeRegExp(pattern) : pattern;
		const flags = `g${args?.ignoreCase === true ? "i" : ""}`;
		const re = new RegExp(source, flags);
		let last = 0;
		let out = "";
		let matched = false;
		for (const match of content.matchAll(re)) {
			const index = match.index ?? 0;
			const text = match[0] ?? "";
			if (!text) continue;
			out += theme.fg("dim", content.slice(last, index));
			out += theme.fg("accent", text);
			last = index + text.length;
			matched = true;
		}
		if (!matched) return theme.fg("dim", content || " ");
		out += theme.fg("dim", content.slice(last));
		return out;
	} catch {
		return theme.fg("dim", content || " ");
	}
}

function formatGroupedGrepPreview(lines: string[], args: any, theme: Theme): string[] {
	const allLineNumbers = lines
		.map((line) => line.match(/^\s*(\d+):\s?(.*)$/)?.[1])
		.filter((lineNo): lineNo is string => typeof lineNo === "string");
	const lineNoWidth = Math.max(3, ...allLineNumbers.map((lineNo) => lineNo.length));
	const out: string[] = [];
	let group: Array<{ lineNo: string; content: string }> = [];
	const flush = (): void => {
		if (group.length === 0) return;
		for (const entry of group) {
			const lineNo = entry.lineNo.padStart(lineNoWidth);
			out.push(`${NOWRAP_MARK}${theme.fg("muted", lineNo)} ${theme.fg("dim", "│")} ${highlightGrepMatch(entry.content, args, theme)}`);
		}
		group = [];
	};
	for (const line of lines) {
		const fileHeader = line.match(/^>\s+(.+?)\s+\((\d+) matches\):?\s*$/);
		if (fileHeader) {
			flush();
			out.push(`${theme.fg("muted", `> ${fileHeader[1]} (${fileHeader[2]} matches)`)}`);
			continue;
		}
		const matchLine = line.match(/^\s*(\d+):\s?(.*)$/);
		if (matchLine) {
			group.push({ lineNo: matchLine[1] ?? "", content: matchLine[2] ?? "" });
			continue;
		}
		flush();
		out.push(theme.fg("dim", line));
	}
	flush();
	return out;
}

function patchRtkRewriteNotifications(ui: any): void {
	if (!ui || ui[RTK_NOTIFY_PATCH_FLAG]) return;
	const originalNotify = ui.notify;
	if (typeof originalNotify !== "function") return;
	ui.notify = function patchedRtkNotify(message: string, type?: "info" | "warning" | "error") {
		if (typeof message === "string") {
			const rewrite = parseRtkRewriteNotice(message);
			if (rewrite) {
				rememberRtkRewrite(rewrite);
				return;
			}
		}
		return originalNotify.call(this, message, type);
	};
	ui[RTK_NOTIFY_PATCH_FLAG] = true;
}

function buildGrepRtkAliases(args: any): string[] {
	const pattern = typeof args?.pattern === "string" ? args.pattern : "";
	if (!pattern) return [];
	const path = typeof args?.path === "string" && args.path ? args.path : "";
	const glob = typeof args?.glob === "string" && args.glob ? args.glob : "";
	const type = typeof args?.type === "string" && args.type ? args.type : "";
	const extras = [glob ? `glob ${glob}` : "", type ? `type ${type}` : "", args?.literal === true ? "literal" : ""].filter(Boolean).join(" ");
	const quoted = JSON.stringify(pattern);
	return [...new Set([
		[`grep ${quoted}`, path ? `in ${path}` : "", extras].filter(Boolean).join(" "),
		[`grep ${pattern}`, path, extras].filter(Boolean).join(" "),
		[`rg ${quoted}`, path, extras].filter(Boolean).join(" "),
		[`rg ${pattern}`, path, extras].filter(Boolean).join(" "),
		[path, pattern].filter(Boolean).join(":"),
		[path, quoted].filter(Boolean).join(" "),
		`${quoted}${path ? ` in ${path}` : ""}`,
		JSON.stringify(args),
	].filter((value) => value.trim().length > 0))];
}

function buildGrepRtkPreview(args: any): string | undefined {
	return buildGrepRtkAliases(args)[0];
}

function trackRtkOriginalToolPreview(toolName: unknown, toolCallId: unknown, args: unknown): void {
	if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
	let preview: string | undefined;
	if (toolName === "bash") {
		const command = (args as any)?.command;
		if (typeof command === "string" && command.trim()) {
			preview = command;
			RTK_ORIGINAL_BASH_COMMANDS.set(toolCallId, command);
		}
	} else if (toolName === "grep") {
		const aliases = buildGrepRtkAliases(args);
		preview = aliases[0];
		if (aliases.length > 0) RTK_ORIGINAL_TOOL_PREVIEW_ALIASES.set(toolCallId, aliases);
	}
	if (preview) RTK_ORIGINAL_TOOL_PREVIEWS.set(toolCallId, preview);
}

function trackRtkOriginalBashCommand(toolCallId: unknown, args: unknown): void {
	trackRtkOriginalToolPreview("bash", toolCallId, args);
}

function forgetRtkBashCommand(toolCallId: unknown): void {
	if (typeof toolCallId !== "string") return;
	RTK_ORIGINAL_BASH_COMMANDS.delete(toolCallId);
	RTK_ORIGINAL_TOOL_PREVIEWS.delete(toolCallId);
	RTK_ORIGINAL_TOOL_PREVIEW_ALIASES.delete(toolCallId);
	RTK_REWRITES_BY_TOOL_ID.delete(toolCallId);
}

function clearRtkRewriteState(): void {
	RTK_ORIGINAL_BASH_COMMANDS.clear();
	RTK_ORIGINAL_TOOL_PREVIEWS.clear();
	RTK_ORIGINAL_TOOL_PREVIEW_ALIASES.clear();
	RTK_REWRITES_BY_TOOL_ID.clear();
	RTK_PENDING_REWRITES.length = 0;
	clearPreservedBashPreviews();
}

function toolStatusDot(ctx: any, theme: Theme): string {
	const status = ctx.state?._toolStatus as "pending" | "success" | "error" | undefined;
	if (status === "success") return `${theme.fg("success", "●")} `;
	if (status === "error") return `${theme.fg("error", "●")} `;
	return `${blinkDot(ctx, theme)} `;
}

// ---------------------------------------------------------------------------
// Blink timer for partial (running) states
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Global blink timer — single timer invalidates all active contexts
// ---------------------------------------------------------------------------

const MAX_BLINKING_TOOLS = 5;
const BLINK_INTERVAL_MS = 500;

type BlinkEntry = { key: any; order: number; invalidate: () => void };

const _blinkContexts = new Map<any, BlinkEntry>();
let _globalBlinkTimer: ReturnType<typeof setTimeout> | null = null;
let _blinkOrder = 0;
let _globalBlinkPhase = true;

function getBlinkIntervalMs(): number {
	return BLINK_INTERVAL_MS;
}

function getBlinkKey(ctx: any): any {
	return ctx?.state ?? ctx;
}

function getBlinkingEntries(): BlinkEntry[] {
	return [..._blinkContexts.values()]
		.sort((a, b) => b.order - a.order)
		.slice(0, MAX_BLINKING_TOOLS);
}

function updateBlinkActiveStates(skipInvalidateKey?: any): void {
	const activeSet = new Set(getBlinkingEntries().map((entry) => entry.key));
	for (const entry of _blinkContexts.values()) {
		const active = activeSet.has(entry.key);
		if (entry.key?._blinkActive !== active) {
			entry.key._blinkActive = active;
			if (entry.key !== skipInvalidateKey) {
				try { entry.invalidate(); } catch { /* noop */ }
			}
		}
	}
}

function _scheduleGlobalBlinkTimer(): void {
	if (_globalBlinkTimer) return;
	const intervalMs = getBlinkIntervalMs();
	if (_blinkContexts.size === 0) return;
	_globalBlinkTimer = setTimeout(() => {
		_globalBlinkTimer = null;
		if (_blinkContexts.size === 0) {
			updateBlinkActiveStates();
			return;
		}
		_globalBlinkPhase = !_globalBlinkPhase;
		for (const entry of getBlinkingEntries()) {
			try { entry.invalidate(); } catch { /* noop */ }
		}
		_scheduleGlobalBlinkTimer();
	}, intervalMs);
	unrefTimer(_globalBlinkTimer);
}

function _stopGlobalBlinkTimerIfEmpty(): void {
	if (_globalBlinkTimer && _blinkContexts.size === 0) {
		clearTimeout(_globalBlinkTimer);
		_globalBlinkTimer = null;
	}
}

function setupBlinkTimer(ctx: any): void {
	const key = getBlinkKey(ctx);
	if (!key) return;
	const invalidate = typeof ctx?.invalidate === "function" ? () => safeInvalidate(ctx) : () => {};
	const existing = _blinkContexts.get(key);
	if (existing) {
		// Already tracked — just refresh the invalidate fn, skip expensive recalc
		existing.invalidate = invalidate;
		return;
	}
	_blinkContexts.set(key, { key, order: ++_blinkOrder, invalidate });
	key._blinkActive = false;
	// Avoid re-entrant ToolExecutionComponent.invalidate() while updateDisplay()
	// is still adding call/result children. Re-entry duplicates Box children.
	updateBlinkActiveStates(key);
	_stopGlobalBlinkTimerIfEmpty();
	_scheduleGlobalBlinkTimer();
}

function clearBlinkTimer(ctx: any): void {
	const key = getBlinkKey(ctx);
	if (!key) return;
	_blinkContexts.delete(key);
	key._blinkActive = false;
	updateBlinkActiveStates();
	_stopGlobalBlinkTimerIfEmpty();
	_scheduleGlobalBlinkTimer();
}

function pendingToolChromeColor(theme: Theme): "dim" | "muted" | "thinkingText" {
	if (!themeAdaptiveEnabled()) return "muted";
	return "dim";
}

function blinkDot(ctx: any, theme: Theme): string {
	setupBlinkTimer(ctx);
	const key = getBlinkKey(ctx);
	const idle = pendingToolChromeColor(theme);
	if (key?._blinkActive !== true) return theme.fg(idle, "○");
	return _globalBlinkPhase ? theme.fg("success", "●") : theme.fg(idle, "○");
}

// ---------------------------------------------------------------------------
// File icons — Nerd Font glyphs (requires Nerd Font terminal)
// ---------------------------------------------------------------------------

const NF_DIR = `\x1b[38;2;100;140;220m\ue5ff\x1b[0m`;
const NF_DEFAULT = `\x1b[38;2;80;80;80m\uf15b\x1b[0m`;

const EXT_ICON: Record<string, string> = {
	ts: `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
	tsx: `\x1b[38;2;49;120;198m\ue7ba\x1b[0m`,
	js: `\x1b[38;2;241;224;90m\ue74e\x1b[0m`,
	jsx: `\x1b[38;2;97;218;251m\ue7ba\x1b[0m`,
	py: `\x1b[38;2;55;118;171m\ue73c\x1b[0m`,
	rs: `\x1b[38;2;222;165;132m\ue7a8\x1b[0m`,
	go: `\x1b[38;2;0;173;216m\ue724\x1b[0m`,
	java: `\x1b[38;2;204;62;68m\ue738\x1b[0m`,
	rb: `\x1b[38;2;204;52;45m\ue739\x1b[0m`,
	swift: `\x1b[38;2;255;172;77m\ue755\x1b[0m`,
	c: `\x1b[38;2;85;154;211m\ue61e\x1b[0m`,
	cpp: `\x1b[38;2;85;154;211m\ue61d\x1b[0m`,
	html: `\x1b[38;2;228;77;38m\ue736\x1b[0m`,
	css: `\x1b[38;2;66;165;245m\ue749\x1b[0m`,
	scss: `\x1b[38;2;207;100;154m\ue749\x1b[0m`,
	vue: `\x1b[38;2;65;184;131m\ue6a0\x1b[0m`,
	svelte: `\x1b[38;2;255;62;0m\ue697\x1b[0m`,
	json: `\x1b[38;2;241;224;90m\ue60b\x1b[0m`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
	yml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
	toml: `\x1b[38;2;160;116;196m\ue6b2\x1b[0m`,
	md: `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
	sh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	bash: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	zsh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	lua: `\x1b[38;2;81;160;207m\ue620\x1b[0m`,
	php: `\x1b[38;2;137;147;186m\ue73d\x1b[0m`,
	sql: `\x1b[38;2;218;218;218m\ue706\x1b[0m`,
	xml: `\x1b[38;2;228;77;38m\ue619\x1b[0m`,
	graphql: `\x1b[38;2;224;51;144m\ue662\x1b[0m`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0\x1b[0m`,
	lock: `\x1b[38;2;130;130;130m\uf023\x1b[0m`,
	png: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
	svg: `\x1b[38;2;255;180;50m\uf1c5\x1b[0m`,
	gif: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
};

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e\x1b[0m`,
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
	".gitignore": `\x1b[38;2;222;165;132m\ue702\x1b[0m`,
	"dockerfile": `\x1b[38;2;56;152;236m\ue7b0\x1b[0m`,
	"makefile": `\x1b[38;2;130;130;130m\ue615\x1b[0m`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
	"license": `\x1b[38;2;218;218;218m\ue60a\x1b[0m`,
};

function fileIcon(fp: string): string {
	const base = fp.split('/').pop()?.toLowerCase() ?? '';
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
	const ext = base.includes('.') ? base.split('.').pop() ?? '' : '';
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

function dirIcon(): string {
	return `${NF_DIR} `;
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}


function markedContinuationPrefix(prefix: string): string {
	const plain = stripAnsi(prefix);
	const branchMatch = /^(\s*)(?:│  |├─ |└─ )/.exec(plain);
	if (branchMatch) {
		return `${branchMatch[1]}${currentToolBranchAnsi()}│${TRANSPARENT_RESET}  `;
	}
	return " ".repeat(visibleWidth(prefix));
}

function wrapMarkedLine(line: string, width: number): string[] {
	const markerIndex = line.indexOf(WRAP_MARK);
	if (markerIndex === -1) return wrapTextWithAnsi(line, width);
	const prefix = line.slice(0, markerIndex);
	const body = line.slice(markerIndex + WRAP_MARK.length);
	const prefixWidth = visibleWidth(prefix);
	const bodyWidth = Math.max(1, width - prefixWidth);
	if (body.startsWith(NOWRAP_MARK)) {
		const clipped = truncateToWidth(body.slice(NOWRAP_MARK.length), bodyWidth, `${FG_DIM}…${TRANSPARENT_RESET}`, false);
		return [`${prefix}${clipped}`];
	}
	const wrapped = wrapTextWithAnsi(body, bodyWidth);
	const continuation = markedContinuationPrefix(prefix);
	return wrapped.map((part, index) => (index === 0 ? `${prefix}${part}` : `${continuation}${part}`));
}

class ToolText extends Text {
	private value = "";
	private toolCachedValue?: string;
	private toolCachedWidth?: number;
	private toolCachedLines?: string[];

	constructor(text = "") {
		super("", 0, 0);
		this.value = text;
	}

	setText(text: string): void {
		if (this.value === text) return;
		this.value = text;
		this.invalidate();
	}

	invalidate(): void {
		this.toolCachedValue = undefined;
		this.toolCachedWidth = undefined;
		this.toolCachedLines = undefined;
	}

	render(width: number): string[] {
		const branchKey = toolBranchRenderCacheKey();
		if (
			this.toolCachedLines
			&& this.toolCachedValue === this.value
			&& this.toolCachedWidth === width
			&& (this as any)._toolBranchCacheKey === branchKey
			&& (this as any)._toolBranchCacheEpoch === _toolBranchVisualEpoch
		) return this.toolCachedLines;
		if (!this.value || this.value.trim() === "") {
			this.toolCachedValue = this.value;
			this.toolCachedWidth = width;
			this.toolCachedLines = [];
			return this.toolCachedLines;
		}
		const contentWidth = Math.max(1, width);
		const lines = this.value.replace(/\t/g, "   ").split("\n");
		const rendered = lines.flatMap((line) => wrapMarkedLine(line, contentWidth)).map((line) => padToWidth(line, width));
		this.toolCachedValue = this.value;
		this.toolCachedWidth = width;
		this.toolCachedLines = rendered;
		(this as any)._toolBranchCacheKey = branchKey;
		(this as any)._toolBranchCacheEpoch = _toolBranchVisualEpoch;
		return rendered;
	}
}

function makeText(last: unknown, text: string): Text {
	const component = last instanceof ToolText ? last : new ToolText();
	component.setText(text);
	return component;
}

configurePreviewRenderer({ collapsedPreviewCount, toolOutputDetailHint });
configureMarkdownRenderer({
	WORKED_LINE_FG,
	RESET,
	toolBranchVisualEpoch: () => _toolBranchVisualEpoch,
	sanitizeRenderedTextBlockLines,
	normalizeLeadingCheckGlyph,
	isCodeBoxChromeLine,
});

// ===========================================================================
// Diff rendering — adapted from /tmp/pi-diff
// ===========================================================================

interface DiffPreset {
	name: string;
	description: string;
	shikiTheme?: string;
	bgAdd?: string;
	bgDel?: string;
	bgAddHighlight?: string;
	bgDelHighlight?: string;
	bgGutterAdd?: string;
	bgGutterDel?: string;
	bgEmpty?: string;
	fgAdd?: string;
	fgDel?: string;
	fgDim?: string;
	fgLnum?: string;
	fgRule?: string;
	fgStripe?: string;
	fgSafeMuted?: string;
}

interface DiffUserConfig {
	diffTheme?: string;
	diffColors?: Record<string, string>;
}

const DIFF_PRESETS: Record<string, DiffPreset> = {
	default: {
		name: "default",
		description: "Original pi-diff colors",
		bgAdd: "#162620",
		bgDel: "#2d1919",
		bgAddHighlight: "#234b32",
		bgDelHighlight: "#502323",
		bgGutterAdd: "#12201a",
		bgGutterDel: "#261616",
		bgEmpty: "#121212",
		fgDim: "#505050",
		fgLnum: "#646464",
		fgRule: "#323232",
		fgStripe: "#282828",
		fgSafeMuted: "#8b949e",
	},
	midnight: {
		name: "midnight",
		description: "Subtle tints for black backgrounds",
		bgAdd: "#0d1a12",
		bgDel: "#1a0d0d",
		bgAddHighlight: "#1a3825",
		bgDelHighlight: "#381a1a",
		bgGutterAdd: "#091208",
		bgGutterDel: "#120908",
		bgEmpty: "#080808",
		fgDim: "#404040",
		fgLnum: "#505050",
		fgRule: "#282828",
		fgStripe: "#1e1e1e",
		fgSafeMuted: "#8b949e",
	},
	neon: {
		name: "neon",
		description: "Higher contrast backgrounds",
		bgAdd: "#1a3320",
		bgDel: "#331a16",
		bgAddHighlight: "#2d5c3a",
		bgDelHighlight: "#5c2d2d",
		bgGutterAdd: "#142818",
		bgGutterDel: "#28120e",
		bgEmpty: "#141414",
		fgDim: "#606060",
		fgLnum: "#787878",
		fgRule: "#404040",
		fgStripe: "#303030",
		fgSafeMuted: "#9da5ae",
	},
};

function loadDiffConfig(): DiffUserConfig {
	const settings = readSettings();
	return { diffTheme: settings.diffTheme, diffColors: settings.diffColors };
}

// 6x6x6 color cube channel values used by pi's 256color fallback.
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

function xterm256ToRgb(index: number): { r: number; g: number; b: number } | null {
	if (!Number.isInteger(index) || index < 0 || index > 255) return null;
	if (index < 16) {
		// Standard 16 ANSI colors — terminal-defined, approximate with VS Code defaults.
		const basic: Array<[number, number, number]> = [
			[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
			[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
			[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
			[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
		];
		const [r, g, b] = basic[index];
		return { r, g, b };
	}
	if (index < 232) {
		const i = index - 16;
		return {
			r: CUBE_VALUES[Math.floor(i / 36) % 6],
			g: CUBE_VALUES[Math.floor(i / 6) % 6],
			b: CUBE_VALUES[i % 6],
		};
	}
	const level = 8 + (index - 232) * 10;
	return { r: level, g: level, b: level };
}

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	if (!ansi) return null;
	const esc = "\u001b";
	// Truecolor: \e[38;2;R;G;Bm or \e[48;2;R;G;Bm
	const tc = ansi.match(new RegExp(`${esc}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	if (tc) return { r: +tc[1], g: +tc[2], b: +tc[3] };
	// 256-color: \e[38;5;Nm or \e[48;5;Nm — happens on Apple Terminal, screen, etc.
	const idx = ansi.match(new RegExp(`${esc}\\[(?:38|48);5;(\\d+)m`));
	if (idx) return xterm256ToRgb(+idx[1]);
	return null;
}

function hexToBgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function hexToFgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

// ---------------------------------------------------------------------------
// Theme palette extraction — pull RGB from the active pi theme so our
// hardcoded greys and accent colors track the user's selected theme.
//
// `theme.getFgAnsi(name)` / `theme.getBgAnsi(name)` return raw ANSI escapes
// (either truecolor or 256color depending on the terminal). We parse those
// back into RGB so we can mix tints for diff backgrounds.
// ---------------------------------------------------------------------------

type Rgb = { r: number; g: number; b: number };

function safeFgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getFgAnsi?.(key);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
	} catch {
		return null;
	}
}

function safeBgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getBgAnsi?.(key);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
	} catch {
		return null;
	}
}

function themeFgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeFgAnsi(theme, key);
	return ansi ? parseAnsiRgb(ansi) : null;
}

function themeBgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeBgAnsi(theme, key);
	return ansi ? parseAnsiRgb(ansi) : null;
}

// Cache theme identity so we only recompute on theme change. The Theme
// object is reused across renders within a single session unless the user
// switches themes via the picker.
let _themePaletteCacheTheme: unknown = null;
let _themePaletteCacheName: string | null = null;
let _themePaletteCacheFingerprint: string | null = null;

/** Resolved-color fingerprint so palette re-derives when the active theme file changes under the same name/object. */
function themePaletteFingerprint(theme: any): string {
	const keys = ["success", "error", "borderMuted", "accent", "muted", "toolDiffAdded", "toolDiffRemoved"] as const;
	return keys.map((k) => safeFgAnsi(theme, k) ?? "").join("\u001f");
}

function invalidateThemePaletteCache(): void {
	_themePaletteCacheTheme = null;
	_themePaletteCacheName = null;
	_themePaletteCacheFingerprint = null;
}

function themeAdaptiveEnabled(): boolean {
	const settings = readSettings();
	return settings.themeAdaptive !== false;
}

let DIFF_THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark";
/** True when the active pi theme has a light panel background (edit/write diff chrome). */
let _diffOnLightBg = false;
let codeToAnsiLoader: Promise<any> | null = null;

const SPLIT_MIN_WIDTH = 150;
const SPLIT_MIN_CODE_WIDTH = 60;
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;
const MAX_TERM_WIDTH = 210;
const DEFAULT_TERM_WIDTH = 200;
const MAX_PREVIEW_LINES = 60;
const MAX_RENDER_LINES = 150;
const MAX_HL_CHARS = 32_000;
const STREAM_EDIT_DIFF_MAX_LINES = 300;
const STREAM_EDIT_DIFF_MAX_CHARS = 30_000;
const ASYNC_DIFF_TIMEOUT_MS = 5_000;
const CACHE_LIMIT = 48;
const WORD_DIFF_MIN_SIM = 0.15;
const WORD_DIFF_MAX_PAIR_CHARS = 1_000;
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;

let D_RST = "\x1b[0m";
const D_BOLD = "\x1b[1m";
const D_DIM = "\x1b[2m";

// Diff backgrounds — defaults are transparent; autoDeriveBgFromTheme fills them
// using pi-tool-display's mix ratios against the theme's toolSuccessBg.
let BG_ADD = "\x1b[49m";
let BG_DEL = "\x1b[49m";
let BG_ADD_W = "\x1b[49m";
let BG_DEL_W = "\x1b[49m";
let BG_GUTTER_ADD = "\x1b[49m";
let BG_GUTTER_DEL = "\x1b[49m";
let BG_EMPTY = "\x1b[49m";
let BG_BASE = "\x1b[49m";

let FG_ADD = "\x1b[38;2;100;180;120m";
let FG_DEL = "\x1b[38;2;200;100;100m";
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
// Tool branch connectors (├─ └─ │). Default fixed gray 72 — independent of pi theme.
const DEFAULT_TOOL_BRANCH_GRAY = 72;

function toolBranchRgbAnsi(gray: number): string {
	const g = Math.max(0, Math.min(255, Math.round(gray)));
	return `\x1b[38;2;${g};${g};${g}m`;
}

function ansiRgbBrightenedBy(ansi: string, delta: number): string | null {
	const rgb = parseAnsiRgb(ansi);
	if (!rgb) return null;
	const bump = (c: number) => Math.max(0, Math.min(255, Math.round(c + delta)));
	return `\x1b[38;2;${bump(rgb.r)};${bump(rgb.g)};${bump(rgb.b)}m`;
}

/** Outline chrome always brighter than branch; never falls back to identical branch ANSI. */
function outlineChromeAnsiFromBranch(theme?: any): string {
	const t = theme ?? _toolBranchThemeHint;
	const branch = currentToolBranchAnsi(t);
	const fromBranch = ansiRgbBrightenedBy(branch, OUTLINE_CHROME_BRIGHTEN);
	if (fromBranch) return fromBranch;
	let gray = DEFAULT_TOOL_BRANCH_GRAY;
	if (toolBranchColorModeFixed()) {
		gray = getConfiguredToolBranchGray();
	} else if (t) {
		const hint = safeFgAnsi(t, "dim") ?? safeFgAnsi(t, "muted") ?? safeFgAnsi(t, "borderMuted");
		const rgb = hint ? parseAnsiRgb(hint) : null;
		if (rgb) gray = Math.round((rgb.r + rgb.g + rgb.b) / 3);
	}
	return toolBranchRgbAnsi(Math.min(255, gray + OUTLINE_CHROME_BRIGHTEN));
}

function getConfiguredToolBranchGray(): number {
	const raw = readSettings().toolBranchRgbGray;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(255, Math.round(raw))) : DEFAULT_TOOL_BRANCH_GRAY;
}

function toolBranchColorModeFixed(): boolean {
	return readSettings().toolBranchColorMode !== "theme";
}

function toolBranchRenderCacheKey(): string {
	if (toolBranchColorModeFixed()) return `fixed:${getConfiguredToolBranchGray()}`;
	return `theme:${stripAnsi(TOOL_RULE)}`;
}

let _toolBranchVisualEpoch = 0;

function bumpToolBranchVisualEpoch(): void {
	_toolBranchVisualEpoch++;
}

/** On light panels, theme dim/muted can be nearly white — pull chrome toward mid-gray. */
function attenuateChromeAnsi(ansi: string, theme: any): string {
	const rgb = parseAnsiRgb(ansi);
	if (!rgb) return ansi;
	if (!isLightThemeBackground(theme)) return ansi;
	const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
	// Already quiet enough on light backgrounds.
	if (lum <= 145) return ansi;
	const target = 118;
	const t = Math.min(1, (lum - 130) / 110);
	const mix = (c: number) => Math.round(c + (target - c) * t);
	return `\x1b[38;2;${mix(rgb.r)};${mix(rgb.g)};${mix(rgb.b)}m`;
}

/** Shared outline chrome: user box, tool rules, code fences, branch connectors. */
function resolveThemeChromeFg(theme: any): string | null {
	if (!theme || !themeAdaptiveEnabled()) return null;
	const dim = safeFgAnsi(theme, "dim");
	const muted = safeFgAnsi(theme, "muted");
	const borderMuted = safeFgAnsi(theme, "borderMuted");
	const thinking = safeFgAnsi(theme, "thinkingText");
	const raw = dim ?? muted ?? borderMuted ?? thinking;
	return raw ? attenuateChromeAnsi(raw, theme) : null;
}

/** Resolve ├─ └─ │ color from settings + theme on every use (not a stale global). */
let _toolBranchThemeHint: any;

function currentToolBranchAnsi(theme?: any): string {
	const t = theme ?? _toolBranchThemeHint;
	if (toolBranchColorModeFixed()) {
		return toolBranchRgbAnsi(getConfiguredToolBranchGray());
	}
	const chrome = t ? resolveThemeChromeFg(t) : null;
	if (chrome) return chrome;
	return toolBranchRgbAnsi(getConfiguredToolBranchGray());
}

configureBranchRenderer({ currentToolBranchAnsi, transparentReset: TRANSPARENT_RESET, wrapMark: WRAP_MARK });

/** User box, code fences, thinking/thought: branch + OUTLINE_CHROME_BRIGHTEN (never same as branch). */
function syncOutlineChromeFromBranch(theme?: any): void {
	const outline = outlineChromeAnsiFromBranch(theme);
	const prevBorder = BORDER_COLOR;
	BORDER_COLOR = outline;
	WORKED_LINE_FG = outline;
	CODE_BLOCK_LANG_FG = outline;
	if (outline !== prevBorder) bumpToolBranchVisualEpoch();
}

function applyToolBranchColor(theme?: any): void {
	if (theme) _toolBranchThemeHint = theme;
	const prev = TOOL_RULE;
	TOOL_RULE = currentToolBranchAnsi(theme);
	if (TOOL_RULE !== prev) bumpToolBranchVisualEpoch();
	syncOutlineChromeFromBranch(theme);
}

/** Strip baked ├─ └─ │ prefixes so branch color can be reapplied. */
function stripBranchMarkupLine(line: string): string {
	let plain = stripAnsi(line);
	plain = plain.replace(/^\s*[├└]─\s*/, "");
	plain = plain.replace(/^\s*│\s{0,2}/, "");
	return plain;
}

function stripBranchMarkupBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => (stripAnsi(line).trim() ? stripBranchMarkupLine(line) : line))
		.join("\n");
}

function liveBranchDisplay(state: Record<string, unknown> | undefined, theme: Theme): string | undefined {
	if (!state || typeof state !== "object") return undefined;
	const body = state._ptBody;
	if (typeof body === "string" && body.trim() && !body.includes("(rendering")) {
		return indentBranchBlock(withBranch(body, theme, false, true));
	}
	const display = state._ptDisplay;
	if (typeof display === "string" && display.trim()) {
		// _ptDisplay is already branch-wrapped markup. Do not strip/re-wrap it:
		// that drops ANSI diff highlighting and leaks the internal WRAP_MARK.
		return display;
	}
	return undefined;
}

function refreshToolBranchDisplaysInState(state: Record<string, unknown> | undefined, theme: Theme): void {
	if (!state || typeof state !== "object") return;
	const body = state._ptBody;
	if (typeof body === "string" && body.trim() && !body.includes("(rendering")) {
		state._ptDisplay = indentBranchBlock(withBranch(body, theme, false, true));
	}
}

function refreshAllToolBranchVisuals(ctx: any): void {
	invalidateSettingsCache();
	syncToolBackgroundMode();
	invalidateThemePaletteCache();
	applyToolBackgroundMode(ctx?.ui?.theme);
	applyToolBranchColor(ctx?.ui?.theme);
	bumpToolBranchVisualEpoch(); // always bust ToolText + container caches after /cc-tools branch
	// Tool rows recompute branch markup on next render (liveBranchDisplay + cache bust).
	if (ctx?.hasUI) {
		try {
			ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
			ctx.ui.invalidate?.();
			ctx.ui.requestRender?.();
		} catch { /* noop */ }
	}
}

/** Re-derive borders, branches, diffs, and spinner keys from the active pi theme (no cross-extension deps). */
function rebindUiChromeToTheme(ctx: any): void {
	if (!ctx?.hasUI) return;
	invalidateSettingsCache();
	syncToolBackgroundMode();
	const theme = ctx.ui?.theme;
	invalidateThemePaletteCache();
	clearHighlightCache();
	autoDerivePending = true;
	bustSpinnerSettingsCache();
	applyToolBackgroundMode(theme);
	applyThemePaletteIfNeeded(theme);
	syncDiffShikiTheme(theme);
	if (themeAdaptiveEnabled() && theme?.getFgAnsi) {
		autoDeriveBgFromTheme(theme);
		autoDerivePending = false;
	}
	bumpToolBranchVisualEpoch();
	refreshAllToolBranchVisuals(ctx);
}

function scheduleDeferredChromeRebind(ctx: any, delayMs = 0): void {
	setTimeout(() => {
		try {
			rebindUiChromeToTheme(ctx);
		} catch { /* noop */ }
	}, delayMs);
}

let TOOL_RULE = toolBranchRgbAnsi(DEFAULT_TOOL_BRANCH_GRAY);
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
let FG_STRIPE = "\x1b[38;2;40;40;40m";

let DIVIDER = `${FG_RULE}│${D_RST}`;


let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
let autoDerivePending = true;
let hasExplicitBgConfig = false;

function mixBg(
	base: { r: number; g: number; b: number },
	accent: { r: number; g: number; b: number },
	intensity: number,
): string {
	const r = Math.round(base.r + (accent.r - base.r) * intensity);
	const g = Math.round(base.g + (accent.g - base.g) * intensity);
	const b = Math.round(base.b + (accent.b - base.b) * intensity);
	return `\x1b[48;2;${r};${g};${b}m`;
}

// pi-tool-display tint targets for diff palette derivation
const ADDITION_TINT_TARGET = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET = { r: 232, g: 95, b: 122 };
// Fallback panel bases when theme bg vars are unavailable
const FALLBACK_BASE_BG_DARK = { r: 32, g: 35, b: 42 };
const FALLBACK_BASE_BG_LIGHT = { r: 232, g: 233, b: 236 };

function isLightThemeBackground(theme: any): boolean {
	const panel =
		themeBgRgb(theme, "toolSuccessBg") ||
		themeBgRgb(theme, "userMessageBg") ||
		themeBgRgb(theme, "selectedBg");
	if (panel) {
		const lum = 0.2126 * panel.r + 0.7152 * panel.g + 0.0722 * panel.b;
		return lum > 165;
	}
	const fg = themeFgRgb(theme, "text") || themeFgRgb(theme, "fg");
	if (fg) {
		const lum = 0.2126 * fg.r + 0.7152 * fg.g + 0.0722 * fg.b;
		return lum < 95;
	}
	return false;
}

function syncDiffShikiTheme(theme: any): void {
	if (process.env.DIFF_THEME) return;
	const config = loadDiffConfig();
	if (config.diffTheme) return;
	_diffOnLightBg = isLightThemeBackground(theme);
	DIFF_THEME = (_diffOnLightBg ? "github-light" : "github-dark") as BundledTheme;
	clearHighlightCache();
}
const UNIVERSAL_DIFF_ADD_FG = { r: 110, g: 210, b: 130 };
const UNIVERSAL_DIFF_DEL_FG = { r: 225, g: 110, b: 110 };

function mixRgb(
	a: { r: number; g: number; b: number },
	b: { r: number; g: number; b: number },
	ratio: number,
): { r: number; g: number; b: number } {
	return {
		r: a.r + (b.r - a.r) * ratio,
		g: a.g + (b.g - a.g) * ratio,
		b: a.b + (b.b - a.b) * ratio,
	};
}

function rgbToBgAnsi(c: { r: number; g: number; b: number }): string {
	return `\x1b[48;2;${Math.round(c.r)};${Math.round(c.g)};${Math.round(c.b)}m`;
}

function autoDeriveBgFromTheme(theme: any): void {
	// Diff palette derivation.
	//
	// `toolDiffAdded` / `toolDiffRemoved` from the active pi theme give us the
	// fg accents. The base background is taken from `toolSuccessBg` (close to
	// the panel color the row will sit on) so the tinted backgrounds blend in
	// instead of forcing a hardcoded dark hue. Falls back to the universal
	// dark palette when the theme is unavailable or themeAdaptive=false.
	const useTheme = themeAdaptiveEnabled() && theme;
	const onLight = useTheme && isLightThemeBackground(theme);
	_diffOnLightBg = !!onLight;
	const addFgRgb = (useTheme && themeFgRgb(theme, "toolDiffAdded")) || UNIVERSAL_DIFF_ADD_FG;
	const delFgRgb = (useTheme && themeFgRgb(theme, "toolDiffRemoved")) || UNIVERSAL_DIFF_DEL_FG;
	const base =
		(useTheme && themeBgRgb(theme, "toolSuccessBg")) ||
		(useTheme && themeBgRgb(theme, "userMessageBg")) ||
		(onLight ? FALLBACK_BASE_BG_LIGHT : FALLBACK_BASE_BG_DARK);

	const addTint = mixRgb(addFgRgb, ADDITION_TINT_TARGET, 0.35);
	const delTint = mixRgb(delFgRgb, DELETION_TINT_TARGET, 0.65);

	FG_ADD = `\x1b[38;2;${Math.round(addFgRgb.r)};${Math.round(addFgRgb.g)};${Math.round(addFgRgb.b)}m`;
	FG_DEL = `\x1b[38;2;${Math.round(delFgRgb.r)};${Math.round(delFgRgb.g)};${Math.round(delFgRgb.b)}m`;
	BG_ADD = rgbToBgAnsi(mixRgb(base, addTint, 0.24));
	BG_DEL = rgbToBgAnsi(mixRgb(base, delTint, 0.12));
	BG_ADD_W = rgbToBgAnsi(mixRgb(base, addTint, 0.44));
	BG_DEL_W = rgbToBgAnsi(mixRgb(base, delTint, 0.26));
	BG_GUTTER_ADD = rgbToBgAnsi(mixRgb(base, addTint, 0.14));
	BG_GUTTER_DEL = rgbToBgAnsi(mixRgb(base, delTint, 0.08));
	BG_EMPTY = TRANSPARENT_BG;
	BG_BASE = TRANSPARENT_BG;
	D_RST = TRANSPARENT_RESET;
	DIVIDER = `${FG_RULE}│${D_RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
	syncDiffRenderPalette();
}

// Track which palette fields the user explicitly set so theme-derived
// updates don't clobber their config.
const _explicitFgFields = new Set<"fgAdd" | "fgDel" | "fgDim" | "fgLnum" | "fgRule" | "fgStripe" | "fgSafeMuted">();

// Original Claude-Code-style palette captured at module-load so we can
// restore it when the user toggles themeAdaptive off at runtime.
const _claudeStyleDefaults = {
	BORDER_COLOR: "\x1b[38;5;238m",
	WORKED_LINE_FG: "\x1b[38;2;140;140;140m",
	CODE_BLOCK_LANG_FG: "\x1b[38;2;95;95;95m",
	TOOL_RULE: toolBranchRgbAnsi(DEFAULT_TOOL_BRANCH_GRAY),
	FG_DIM: "\x1b[38;2;80;80;80m",
	FG_LNUM: "\x1b[38;2;100;100;100m",
	FG_RULE: "\x1b[38;2;50;50;50m",
	FG_STRIPE: "\x1b[38;2;40;40;40m",
	FG_SAFE_MUTED: "\x1b[38;2;139;148;158m",
	FG_ADD: "\x1b[38;2;100;180;120m",
	FG_DEL: "\x1b[38;2;200;100;100m",
	TOOL_STATUS_SUCCESS: "\x1b[32m",
	TOOL_STATUS_ERROR: "\x1b[31m",
	TOOL_STATUS_PENDING: "\x1b[90m",
};

function resetThemePalette(): void {
	BORDER_COLOR = _claudeStyleDefaults.BORDER_COLOR;
	WORKED_LINE_FG = _claudeStyleDefaults.WORKED_LINE_FG;
	CODE_BLOCK_LANG_FG = _claudeStyleDefaults.CODE_BLOCK_LANG_FG;
	applyToolBranchColor();
	TOOL_STATUS_SUCCESS = _claudeStyleDefaults.TOOL_STATUS_SUCCESS;
	TOOL_STATUS_ERROR = _claudeStyleDefaults.TOOL_STATUS_ERROR;
	TOOL_STATUS_PENDING = _claudeStyleDefaults.TOOL_STATUS_PENDING;
	if (!_explicitFgFields.has("fgDim")) FG_DIM = _claudeStyleDefaults.FG_DIM;
	if (!_explicitFgFields.has("fgLnum")) FG_LNUM = _claudeStyleDefaults.FG_LNUM;
	if (!_explicitFgFields.has("fgRule")) FG_RULE = _claudeStyleDefaults.FG_RULE;
	if (!_explicitFgFields.has("fgStripe")) FG_STRIPE = _claudeStyleDefaults.FG_STRIPE;
	if (!_explicitFgFields.has("fgSafeMuted")) FG_SAFE_MUTED = _claudeStyleDefaults.FG_SAFE_MUTED;
	if (!_explicitFgFields.has("fgAdd")) FG_ADD = _claudeStyleDefaults.FG_ADD;
	if (!_explicitFgFields.has("fgDel")) FG_DEL = _claudeStyleDefaults.FG_DEL;
	DIVIDER = `${FG_RULE}│${D_RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
	syncDiffRenderPalette();
}

function applyThemePaletteIfNeeded(theme: any): void {
	if (!theme) return;
	if (!themeAdaptiveEnabled()) {
		applyToolBranchColor(theme);
		syncOutlineChromeFromBranch(theme);
		return;
	}
	const themeName = typeof theme?.name === "string" ? theme.name : "";
	const fingerprint = themePaletteFingerprint(theme);
	if (
		_themePaletteCacheTheme === theme &&
		_themePaletteCacheName === themeName &&
		_themePaletteCacheFingerprint === fingerprint
	) {
		applyToolBranchColor(theme);
		syncOutlineChromeFromBranch(theme);
		return;
	}
	const paletteChanged =
		_themePaletteCacheName !== themeName || _themePaletteCacheFingerprint !== fingerprint;
	if (paletteChanged) bumpToolBranchVisualEpoch();
	_themePaletteCacheTheme = theme;
	_themePaletteCacheName = themeName;
	_themePaletteCacheFingerprint = fingerprint;

	const borderMuted = safeFgAnsi(theme, "borderMuted");
	const muted = safeFgAnsi(theme, "muted");
	const dim = safeFgAnsi(theme, "dim") ?? muted;

	// User box, code fences, thinking/thought text, and ├─ └─ │ all follow branch chrome.
	applyToolBranchColor(theme);

	const chromeFg = BORDER_COLOR;

	// Grouped-tool status counts follow the same semantic theme colors as regular tool dots.
	TOOL_STATUS_SUCCESS = safeFgAnsi(theme, "success") ?? TOOL_STATUS_SUCCESS;
	TOOL_STATUS_ERROR = safeFgAnsi(theme, "error") ?? TOOL_STATUS_ERROR;
	const thinking = safeFgAnsi(theme, "thinkingText");
	TOOL_STATUS_PENDING = dim ?? muted ?? thinking ?? TOOL_STATUS_PENDING;

	// Diff support text colors. These are user-overridable via diffColors.* so
	// we only touch the ones not explicitly set.
	if (!_explicitFgFields.has("fgDim") && muted) FG_DIM = muted;
	if (!_explicitFgFields.has("fgLnum") && muted) FG_LNUM = muted;
	const ruleChrome = chromeFg ?? borderMuted;
	if (!_explicitFgFields.has("fgRule") && ruleChrome) FG_RULE = ruleChrome;
	if (!_explicitFgFields.has("fgStripe") && ruleChrome) FG_STRIPE = ruleChrome;
	if (!_explicitFgFields.has("fgSafeMuted") && muted) FG_SAFE_MUTED = muted;

	DIVIDER = `${FG_RULE}│${D_RST}`;

	// Re-trigger background derivation against the new theme unless the user
	// set explicit bg overrides via diffTheme/diffColors.
	if (!hasExplicitBgConfig) {
		autoDeriveBgFromTheme(theme);
		autoDerivePending = false;
	} else if (themeAdaptiveEnabled()) {
		_diffOnLightBg = isLightThemeBackground(theme);
	}
	syncDiffShikiTheme(theme);
	syncDiffRenderPalette();
}

function applyDiffPalette(): void {
	const config = loadDiffConfig();
	const preset = config.diffTheme ? DIFF_PRESETS[config.diffTheme] : null;
	if (preset) hasExplicitBgConfig = true;
	const overrides = config.diffColors ?? {};
	if (Object.keys(overrides).length > 0) hasExplicitBgConfig = true;
	_explicitFgFields.clear();

	const applyBg = (key: string, presetValue: string | undefined, set: (value: string) => void) => {
		const hex = overrides[key] ?? presetValue;
		if (!hex) return;
		const ansi = hexToBgAnsi(hex);
		if (ansi) set(ansi);
	};
	const applyFg = (
		key: "fgAdd" | "fgDel" | "fgDim" | "fgLnum" | "fgRule" | "fgStripe" | "fgSafeMuted",
		presetValue: string | undefined,
		set: (value: string) => void,
	) => {
		const hex = overrides[key] ?? presetValue;
		if (!hex) return;
		const ansi = hexToFgAnsi(hex);
		if (!ansi) return;
		set(ansi);
		_explicitFgFields.add(key);
	};

	applyBg("bgAdd", preset?.bgAdd, (v) => {
		BG_ADD = v;
	});
	applyBg("bgDel", preset?.bgDel, (v) => {
		BG_DEL = v;
	});
	applyBg("bgAddHighlight", preset?.bgAddHighlight, (v) => {
		BG_ADD_W = v;
	});
	applyBg("bgDelHighlight", preset?.bgDelHighlight, (v) => {
		BG_DEL_W = v;
	});
	applyBg("bgGutterAdd", preset?.bgGutterAdd, (v) => {
		BG_GUTTER_ADD = v;
	});
	applyBg("bgGutterDel", preset?.bgGutterDel, (v) => {
		BG_GUTTER_DEL = v;
	});
	applyBg("bgEmpty", preset?.bgEmpty, (v) => {
		BG_EMPTY = v;
	});

	applyFg("fgAdd", preset?.fgAdd, (v) => {
		FG_ADD = v;
	});
	applyFg("fgDel", preset?.fgDel, (v) => {
		FG_DEL = v;
	});
	applyFg("fgDim", preset?.fgDim, (v) => {
		FG_DIM = v;
	});
	applyFg("fgLnum", preset?.fgLnum, (v) => {
		FG_LNUM = v;
	});
	applyFg("fgRule", preset?.fgRule, (v) => {
		FG_RULE = v;
	});
	applyFg("fgStripe", preset?.fgStripe, (v) => {
		FG_STRIPE = v;
	});
	applyFg("fgSafeMuted", preset?.fgSafeMuted, (v) => {
		FG_SAFE_MUTED = v;
	});

	const shiki = overrides.shikiTheme ?? preset?.shikiTheme;
	if (shiki) DIFF_THEME = shiki as BundledTheme;

	DIVIDER = `${FG_RULE}│${D_RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
	// Only trigger auto-derive when the user did NOT supply an explicit
	// preset or per-color override; otherwise we would overwrite their config
	// with the hardcoded dark palette on first render.
	autoDerivePending = !hasExplicitBgConfig;
	syncDiffRenderPalette();
}

function syncDiffRenderPalette(): void {
	setDiffRenderPalette({
		D_RST,
		BG_ADD,
		BG_DEL,
		BG_ADD_W,
		BG_DEL_W,
		BG_GUTTER_ADD,
		BG_GUTTER_DEL,
		BG_EMPTY,
		BG_BASE,
		FG_ADD,
		FG_DEL,
		FG_DIM,
		FG_LNUM,
		FG_RULE,
		FG_SAFE_MUTED,
		FG_STRIPE,
		DIVIDER,
		DEFAULT_DIFF_COLORS,
		DIFF_THEME,
		diffOnLightBg: _diffOnLightBg,
	});
}

function resolveDiffColors(theme?: any): DiffColors {
	applyThemePaletteIfNeeded(theme);
	if (autoDerivePending && theme?.getFgAnsi) {
		autoDeriveBgFromTheme(theme);
		autoDerivePending = false;
	}
	syncDiffRenderPalette();
	return DEFAULT_DIFF_COLORS;
}


function stripThinkingPresentationArtifacts(text: string): string {
	if (!ANSI_PRESENT_RE.test(text) && !/^\s*thinking:\s*/i.test(text)) return text;
	let current = ANSI_PRESENT_RE.test(text) ? text.replace(ANSI_RE, "") : text;
	while (true) {
		const next = current.replace(/^(?:thinking:\s*)+/i, "").trimStart();
		if (next === current) return current;
		current = next;
	}
}

function prefixThinkingLine(text: string, _theme: Theme | undefined): string {
	if (!ANSI_PRESENT_RE.test(text) && text.startsWith("Thinking: ") && !/^Thinking:\s*thinking:\s*/i.test(text)) {
		return text;
	}
	const normalized = stripThinkingPresentationArtifacts(text).trim();
	if (!normalized) return text;
	return `Thinking: ${normalized}`;
}

function trackThinkingBlockEvents(event: any, ctx?: any): void {
	const evt = event?.assistantMessageEvent;
	const message = event?.message;
	if (!evt || typeof evt.type !== "string") return;
	function refreshThinkingChrome(): void {
		try {
			ctx?.ui?.invalidate?.();
			ctx?.ui?.requestRender?.();
		} catch { /* noop */ }
		// Pi may call AssistantMessageComponent.updateContent before extension
		// handlers run on the same thinking_end event — nudge one more frame.
		setTimeout(() => {
			try {
				ctx?.ui?.invalidate?.();
				ctx?.ui?.requestRender?.();
			} catch { /* noop */ }
		}, 0);
	}

	if (evt.type === "thinking_start") {
		thinkingBlockInFlight = true;
		thinkingBlockStartMs = Date.now();
		lastThinkingBlockDurationMs = undefined;
		if (message?.role === "assistant") {
			(message as any)[THINKING_ACTIVE_KEY] = true;
			delete (message as any)[THINKING_DURATION_KEY];
		}
		refreshThinkingChrome();
		return;
	}
	if (evt.type === "thinking_end") {
		thinkingBlockInFlight = false;
		const duration = Date.now() - thinkingBlockStartMs;
		if (message?.role === "assistant") delete (message as any)[THINKING_ACTIVE_KEY];
		if (duration >= MIN_THINKING_SUMMARY_MS) {
			lastThinkingBlockDurationMs = duration;
			if (message?.role === "assistant") (message as any)[THINKING_DURATION_KEY] = duration;
		} else {
			lastThinkingBlockDurationMs = undefined;
			if (message?.role === "assistant") delete (message as any)[THINKING_DURATION_KEY];
		}
		refreshThinkingChrome();
	}
}

function registerThinkingLabels(pi: ExtensionAPI): void {
	const patchMessage = (event: any, theme?: Theme) => {
		// Keep theme-derived border / dim text colors in sync with the
		// active pi theme. Cheap when the theme hasn't changed (identity check).
		if (theme) applyThemePaletteIfNeeded(theme);
		const message = event?.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (block && block.type === "thinking" && typeof block.thinking === "string") {
				block.thinking = prefixThinkingLine(block.thinking, theme);
			}
		}
	};
	pi.on("before_agent_start", async () => {
		// Start once per top-level request. Steering/follow-up messages can be
		// injected while the agent is already active; those must not reset the
		// request timer.
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
		}
		currentAssistantMessageStartMs = undefined;
		thinkingBlockInFlight = false;
	});
	pi.on("agent_start", async () => {
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
		}
		currentAssistantMessageStartMs = undefined;
	});
	pi.on("message_start", async (event: any) => {
		const message = event?.message;
		if (message?.role === "user" && currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
		}
		if (message?.role === "assistant") {
			currentAssistantMessageStartMs = Date.now();
			(message as any)[WORKED_START_KEY] = currentAssistantMessageStartMs;
			thinkingBlockInFlight = false;
			delete (message as any)[THINKING_ACTIVE_KEY];
		}
	});
	pi.on("message_update", async (event, ctx) => {
		trackThinkingBlockEvents(event, ctx);
		patchMessage(event, ctx.ui?.theme);
	});
	pi.on("message_end", async (event, ctx) => {
		const message = (event as any)?.message;
		if (message?.role === "assistant") {
			if (typeof lastThinkingBlockDurationMs === "number") {
				(message as any)[THINKING_DURATION_KEY] = lastThinkingBlockDurationMs;
			}
			const started = typeof currentAgentWorkStartMs === "number"
				? currentAgentWorkStartMs
				: typeof (message as any)[WORKED_START_KEY] === "number"
					? (message as any)[WORKED_START_KEY]
					: currentAssistantMessageStartMs;
			const isFinalAssistantMessage = message.stopReason !== "toolUse";
			if (started !== undefined && isFinalAssistantMessage) {
				const durationMs = Date.now() - started;
				(message as any)[WORKED_DURATION_KEY] = durationMs;
				// Mutate the message itself before pi renders/persists it. This is more
				// reliable than the spinner because pi removes the loader on agent_end,
				// and more reliable than component monkey-patching when extensions are
				// loaded from a different package instance than the running TUI.
				appendWorkedDurationLine(message, durationMs);
			}
			currentAssistantMessageStartMs = undefined;
		}
		patchMessage(event, ctx.ui?.theme);
	});
	pi.on("agent_end", async () => {
		currentAgentWorkStartMs = undefined;
		currentAssistantMessageStartMs = undefined;
	});
	pi.on("context", async (event) => {
		if (!Array.isArray((event as any).messages)) return;
		for (const msg of (event as any).messages) {
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block && block.type === "thinking" && typeof block.thinking === "string") {
					block.thinking = stripThinkingPresentationArtifacts(block.thinking);
				}
				if (block && block.type === "text" && typeof block.text === "string") {
					block.text = stripWorkedDurationLine(block.text);
				}
			}
		}
	});
}

function getMode<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function getTextContent(result: any): string {
	if (!Array.isArray(result?.content)) return "";
	return result.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function getLivePreviewLines(result: any): string[] {
	const raw = getTextContent(result).replace(/\r\n/g, "\n").trimEnd();
	if (!raw) return [];
	return raw.split("\n").filter((line) => line.trim().length > 0);
}

function lineCountLabel(count: number): string {
	return `${count} line${count === 1 ? "" : "s"}`;
}

function runningPreviewBlock(
	result: any,
	statusText: string,
	expanded: boolean,
	theme: Theme,
	ctx: any,
	options: { lines?: string[]; styleLine?: (line: string) => string; tail?: boolean } = {},
): string {
	setupBlinkTimer(ctx);
	const limit = liveToolPreviewLimit();
	const lines = options.lines ?? getLivePreviewLines(result);
	if (!liveToolPreviewEnabled() || limit <= 0 || lines.length === 0) {
		return withBranch(statusText, theme);
	}

	const styleLine = options.styleLine ?? ((line: string) => theme.fg("dim", line || " "));
	const previewLines = options.tail && !expanded ? lines.slice(-limit) : lines;
	let preview = buildPreviewTextMapped(previewLines, expanded, theme, limit, styleLine);
	if (options.tail && !expanded && lines.length > previewLines.length) {
		preview = `${theme.fg("muted", `... (${lines.length - previewLines.length} earlier lines${toolOutputDetailHint(theme, expanded, true)})`)}\n${preview}`;
	}
	return withBranch(`${statusText} ${theme.fg("muted", `(${lineCountLabel(lines.length)})`)}\n${preview}`, theme);
}

function buildPersistentBashPreview(lines: string[], theme: Theme): string {
	const limit = liveToolPreviewLimit();
	if (!liveToolPreviewEnabled() || limit <= 0 || lines.length === 0) return "";
	const shown = lines.slice(-limit).map((line) => theme.fg("dim", line));
	let preview = shown.join("\n");
	const earlier = lines.length - shown.length;
	if (earlier > 0) {
		preview = `${theme.fg("muted", `... (${earlier} earlier lines${toolOutputDetailHint(theme, false, true)})`)}\n${preview}`;
	}
	return preview;
}

function getStringArg(args: any, ...keys: string[]): string {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function formatLineMeta(line: number, theme: Theme): string {
	return line > 0 ? ` ${theme.fg("muted", `at line ${line}`)}` : "";
}

function getFirstImageBlock(result: any): { data: string; mimeType: string } | undefined {
	if (!Array.isArray(result?.content)) return undefined;
	return result.content.find((block: any) => block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string");
}

function getReadImageFallback(result: any, ctx: any): string {
	const image = getFirstImageBlock(result);
	if (!image) return "";
	let dimensions;
	try {
		dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined;
	} catch {
		dimensions = undefined;
	}
	const path = getStringArg(ctx.args, "path", "file_path");
	const filename = path ? shortPath(ctx.cwd ?? process.cwd(), path) : undefined;
	return imageFallback(image.mimeType, dimensions, filename);
}

function renderReadImageResult(result: any, expanded: boolean, theme: Theme, ctx: any): Text {
	const image = getFirstImageBlock(result);
	const mimeType = image?.mimeType ?? "image";
	const summary = `${theme.fg("success", "Image loaded")} ${theme.fg("muted", `[${mimeType}]`)}`;
	if (!expanded) {
		return makeText(ctx.lastComponent, withBranch(`${summary}${toolOutputDetailHint(theme, expanded)}`, theme));
	}

	const noteLines = getTextContent(result)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^Read image file\b/i.test(line));
	const lines = [summary, ...noteLines.map((line) => theme.fg("dim", line))];
	if (!getCapabilities().images || !ctx.showImages) {
		const fallback = getReadImageFallback(result, ctx);
		if (fallback) lines.push(theme.fg("toolOutput", fallback));
	}
	return makeText(ctx.lastComponent, withBranch(lines.join("\n"), theme));
}

// ===========================================================================
// Extension
// ===========================================================================

export default function (pi: ExtensionAPI) {
	patchToolExecutionBackgroundSync();
	patchToolRenderCacheInvalidation();
	patchReadImageExpansion();
	patchContainerParentTracking();
	patchGlobalToolBorders();
	patchCustomMessageRender();
	patchUserMessageRender();
	patchAssistantMessages();
	patchToolExecutionRenderers();
	applyDiffPalette();
	registerThinkingLabels(pi);
	const asyncDiff = new AsyncDiffService(summarizeDiff);
	pi.on("session_shutdown", () => asyncDiff.dispose());
	configureApplyPatchRenderer({
		BORDER_COLOR,
		TRANSPARENT_RESET,
		clearBlinkTimer,
		formatLineMeta,
		getStringArg,
		getTextContent,
		hashText,
		makeText,
		resolveDiffColors,
		runningPreviewBlock,
		safeInvalidate,
		setToolStatus,
		shortPath,
		stableCallSummary,
		summarizeOpenAiToolCall,
		syncToolCallStatus,
		toolHeader,
		toolOutputDetailHint,
		toolStatusDot,
	});
	configureGenericToolRenderer({
		makeText,
		shortPath,
		stableCallSummary,
		syncToolCallStatus,
		toolHeader,
		toolStatusDot,
	});
	configureMcpToolRenderer({
		clearBlinkTimer,
		getMode,
		getStringArg,
		getTextContent,
		makeText,
		previewLimit,
		readSettings,
		renderGenericToolCall,
		runningPreviewBlock,
		setToolStatus,
		summarizeText,
		toolOutputDetailHint,
	});
	configureOpenAiToolRenderer({
		clearBlinkTimer,
		getStringArg,
		getTextContent,
		makeText,
		previewLimit,
		runningPreviewBlock,
		setToolStatus,
		stableCallSummary,
		summarizeText,
		syncToolCallStatus,
		toolHeader,
		toolOutputDetailHint,
		toolStatusDot,
	});

	// /cc-tools command — control tool chrome, grouping, and detail level.
	const TOOL_MODES = ["outlines", "transparent", "default"] as const;
	const TOOL_BOOL_MODES = ["on", "off", "toggle", "status"] as const;
	const TOOL_SUBCOMMANDS = [...TOOL_MODES, "group", "branch", "status"] as const;
	const booleanMode = (raw: string | undefined, current: boolean): boolean | "status" | undefined => {
		const mode = raw || "toggle";
		if (mode === "on") return true;
		if (mode === "off") return false;
		if (mode === "toggle") return !current;
		if (mode === "status") return "status";
		return undefined;
	};
	const notifyToolStatus = (ctx: any): void => {
		if (!ctx.hasUI) return;
		const branchMode = toolBranchColorModeFixed() ? "fixed" : "theme";
		const branchGray = getConfiguredToolBranchGray();
		const theme = ctx.ui?.theme;
		const chromeHint = branchMode === "theme" && theme
			? (resolveThemeChromeFg(theme) ? " (attenuated on light themes)" : " (fallback gray if theme keys missing)")
			: "";
		const branchLine = branchMode === "fixed"
			? `Branch color: fixed rgb(${branchGray})`
			: `Branch color: theme${chromeHint}`;
		ctx.ui.notify([
			`Tool style: ${toolBackgroundMode}`,
			`Tool grouping: ${toolGroupingEnabled() ? "on" : "off"}`,
			branchLine,
			`  /cc-tools branch <0-255> | theme | fixed | reset`,
		].join("\n"), "info");
	};
	pi.registerCommand("cc-tools", {
		description: "Control tool UI: style and grouped rows",
		getArgumentCompletions(prefix) {
			const parts = prefix.trimStart().split(/\s+/);
			const first = parts[0] ?? "";
			if (parts.length <= 1) {
				return TOOL_SUBCOMMANDS
					.filter((m) => m.startsWith(first))
					.map((m) => ({
						value: m,
						label: m,
						description:
							m === "group" ? "Toggle grouped adjacent/concurrent tool rows"
							: m === "branch" ? "├─ └─ │ gray (0-255), theme, fixed, or reset"
							: m === "status" ? "Show tool UI settings"
							: m === "outlines" ? "Horizontal rules around each tool (default)"
							: m === "transparent" ? "No borders or backgrounds"
							: "Pi built-in tool backgrounds",
					}));
			}
			if (first === "branch") {
				const second = parts[1] ?? "";
				const opts = ["theme", "fixed", "reset", "status"];
				return opts
					.filter((o) => o.startsWith(second))
					.map((o) => ({ value: `branch ${o}`, label: o, description: "Branch connector color" }));
			}
			if (first === "group" || first === "detail" || first === "extra") {
				const second = parts[1] ?? "";
				return TOOL_BOOL_MODES
					.filter((m) => m.startsWith(second))
					.map((m) => ({ value: `${first} ${m}`, label: m, description: `${m} ${first}` }));
			}
			return [];
		},
		async handler(args, ctx) {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";
			if (!sub || sub === "status") {
				notifyToolStatus(ctx);
				return;
			}

			if (sub === "group") {
				const next = booleanMode(parts[1], toolGroupingEnabled());
				if (next === undefined) {
					if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-tools group ${TOOL_BOOL_MODES.join("|")}`, "error");
					return;
				}
				if (next === "status") {
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${toolGroupingEnabled() ? "on" : "off"}`, "info");
					return;
				}
				setToolGroupingEnabled(next);
				if (!next) ungroupActiveToolGroups();
				if (ctx.hasUI) {
					ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
					ctx.ui.notify(`Tool grouping: ${next ? "on" : "off"}${next ? " (future adjacent tool rows)" : ""}`, "info");
				}
				return;
			}

			if (sub === "branch") {
				const arg = parts[1] ?? "status";
				if (arg === "status" || !arg) {
					notifyToolStatus(ctx);
					return;
				}
				if (arg === "reset") {
					writeSettingsKey("toolBranchRgbGray", undefined);
					writeSettingsKey("toolBranchColorMode", undefined);
					if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
					if (ctx.hasUI) ctx.ui.notify(`Branch color → fixed rgb(${DEFAULT_TOOL_BRANCH_GRAY}) (default)`, "info");
					return;
				}
				if (arg === "theme") {
					writeSettingsKey("toolBranchColorMode", "theme");
					if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
					if (ctx.hasUI) ctx.ui.notify("Branch color → follow pi theme (dim/muted)", "info");
					return;
				}
				if (arg === "fixed") {
					writeSettingsKey("toolBranchColorMode", "fixed");
					if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
					if (ctx.hasUI) ctx.ui.notify(`Branch color → fixed rgb(${getConfiguredToolBranchGray()})`, "info");
					return;
				}
				const gray = Number.parseInt(arg, 10);
				if (!Number.isFinite(gray) || gray < 0 || gray > 255) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /cc-tools branch <0-255> | theme | fixed | reset", "error");
					return;
				}
				writeSettingsKey("toolBranchRgbGray", gray);
				writeSettingsKey("toolBranchColorMode", "fixed");
				if (ctx.hasUI) refreshAllToolBranchVisuals(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Branch color → fixed rgb(${gray})`, "info");
				return;
			}

			if (!(TOOL_MODES as readonly string[]).includes(sub)) {
				if (ctx.hasUI) ctx.ui.notify(`Unknown option "${sub}". Try /cc-tools status, /cc-tools branch 72, or /cc-tools group toggle.`, "error");
				return;
			}
			toolBackgroundOverride = sub as typeof toolBackgroundMode;
			toolBackgroundMode = toolBackgroundOverride;
			writeSettingsKey("toolBackground", sub);
			if (ctx.hasUI) {
				applyToolBackgroundMode(ctx.ui.theme);
				ctx.ui.notify(`Tool style → ${sub}`, "info");
			}
		},
	});

	// /cc-theme command — toggle pi-theme-adaptive coloring at runtime.
	const THEME_MODES = ["on", "off", "toggle", "status"] as const;
	pi.registerCommand("cc-theme", {
		description: "Toggle whether tool borders / branch rules / diff colors follow the active pi theme",
		getArgumentCompletions(prefix) {
			return THEME_MODES
				.filter((m) => m.startsWith(prefix))
				.map((m) => ({
					value: m,
					label: m,
					description:
						m === "on" ? "Derive borders, branch rules, dim text and diff tints from the active pi theme (default)"
						: m === "off" ? "Keep the fixed Claude-style palette regardless of theme"
						: m === "toggle" ? "Flip between on and off"
						: "Show the current setting and a preview of the derived colors",
				}));
		},
		async handler(args, ctx) {
			const raw = args.trim().toLowerCase();
			const current = themeAdaptiveEnabled();

			if (!raw || raw === "status") {
				if (!ctx.hasUI) return;
				const theme = ctx.ui.theme as any;
				const themeName = theme?.name ?? "unknown";
				const state = current ? "on" : "off";
				if (raw === "status" && current) {
					const settings = readSettings();
					const verbKey = settings.spinnerVerbColor || "borderAccent";
					const statusKey = settings.spinnerStatusColor || "muted";
					const verbAnsi = safeFgAnsi(theme, verbKey) ?? safeFgAnsi(theme, "accent");
					const statusAnsi = safeFgAnsi(theme, statusKey) ?? safeFgAnsi(theme, "muted");
					const chromePreview = resolveThemeChromeFg(theme);
					// Print a short preview of what we derived.
					const preview = [
						`chrome      : ${chromePreview ? `${chromePreview}─┌ User ├─\x1b[39m` : "(unchanged)"}`,
						`  (user box, tool rules, branches)`, 
						`muted text  : ${safeFgAnsi(theme, "muted") ? `${safeFgAnsi(theme, "muted")}example dim text\x1b[39m` : "(unchanged)"}`,
						`diff add    : ${safeFgAnsi(theme, "toolDiffAdded") ? `${safeFgAnsi(theme, "toolDiffAdded")}+ added line\x1b[39m` : "(unchanged)"}`,
						`diff del    : ${safeFgAnsi(theme, "toolDiffRemoved") ? `${safeFgAnsi(theme, "toolDiffRemoved")}- removed line\x1b[39m` : "(unchanged)"}`,
						`spinner verb: ${verbAnsi ? `${verbAnsi}Cooking…\x1b[39m` : "(unchanged)"} (key: ${verbKey})`,
						`spinner stat: ${statusAnsi ? `${statusAnsi}(thinking · ↓ 10 tokens · 2s)\x1b[39m` : "(unchanged)"} (key: ${statusKey})`,
					].join("\n  ");
					ctx.ui.notify(`Theme adaptive: ${state} (theme "${themeName}")\n  ${preview}`, "info");
				} else {
					ctx.ui.notify(`Theme adaptive: ${state} (theme "${themeName}")`, "info");
				}
				return;
			}

			let next: boolean;
			if (raw === "on") next = true;
			else if (raw === "off") next = false;
			else if (raw === "toggle") next = !current;
			else {
				if (ctx.hasUI) ctx.ui.notify(`Unknown option "${raw}". Options: ${THEME_MODES.join(", ")}`, "error");
				return;
			}

			writeSettingsKey("themeAdaptive", next);
			bustSpinnerSettingsCache();
			// Invalidate caches so the next render re-derives from the active
			// theme (or falls back to the fixed Claude palette).
			invalidateThemePaletteCache();
			autoDerivePending = true;
			if (next) {
				if (ctx.hasUI) applyThemePaletteIfNeeded(ctx.ui.theme);
			} else {
				resetThemePalette();
			}
			if (ctx.hasUI) {
				const label = next ? "on — colors follow pi theme" : "off — fixed Claude palette";
				ctx.ui.notify(`Theme adaptive: ${label}`, "info");
			}
		},
	});

	// /cc-spinner command — pick which theme color keys drive the spinner verb
	// and status suffix.
	const COMMON_COLOR_KEYS: readonly string[] = [
		"accent", "borderAccent", "success", "error", "warning",
		"muted", "dim", "text", "thinkingText",
		"toolTitle", "mdHeading", "mdCode", "mdLink", "mdListBullet",
		"bashMode",
		"thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
		"syntaxKeyword", "syntaxFunction", "syntaxString", "syntaxType",
	];
	pi.registerCommand("cc-spinner", {
		description: "Set the spinner verb or status theme color, or preview current values",
		getArgumentCompletions(prefix) {
			const subCommands = ["verb", "status", "reset", "preview"];
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				return subCommands
					.filter((c) => c.startsWith(parts[0] ?? ""))
					.map((c) => ({
						value: c,
						label: c,
						description:
							c === "verb" ? "Set the color key used for the spinner verb (e.g. 'Cooking…')"
							: c === "status" ? "Set the color key used for the spinner status suffix"
							: c === "reset" ? "Reset both verb and status to defaults (borderAccent, muted)"
							: "Preview every theme color key with its current sample",
					}));
			}
			// Second arg: color key completions for verb/status.
			if (parts[0] === "verb" || parts[0] === "status") {
				const keyPrefix = (parts[1] ?? "").toLowerCase();
				return COMMON_COLOR_KEYS
					.filter((k) => k.toLowerCase().startsWith(keyPrefix))
					.map((k) => ({ value: k, label: k, description: `theme.fg("${k}", …)` }));
			}
			return [];
		},
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
			const sub = (parts[0] ?? "").toLowerCase();
			const theme = ctx.hasUI ? (ctx.ui.theme as any) : null;
			const settings = readSettings();
			const currentVerb = settings.spinnerVerbColor || "borderAccent";
			const currentStatus = settings.spinnerStatusColor || "muted";

			if (!sub || sub === "preview") {
				if (!ctx.hasUI) return;
				if (!theme) {
					ctx.ui.notify(`Spinner verb: ${currentVerb}, status: ${currentStatus} (no theme)`, "info");
					return;
				}
				const lines: string[] = [
					`Current: verb=${currentVerb}, status=${currentStatus}`,
					"",
					"Preview of common theme keys (pick one for verb or status):",
				];
				for (const key of COMMON_COLOR_KEYS) {
					const ansi = safeFgAnsi(theme, key);
					const marker = key === currentVerb ? "(verb)" : key === currentStatus ? "(status)" : "";
					const sample = ansi ? `${ansi}Cooking…\x1b[39m` : "(unmapped)";
					lines.push(`  ${key.padEnd(16)} ${sample} ${marker}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "reset") {
				writeSettingsKey("spinnerVerbColor", undefined);
				writeSettingsKey("spinnerStatusColor", undefined);
				bustSpinnerSettingsCache();
				if (ctx.hasUI) ctx.ui.notify("Spinner colors reset to defaults (verb=borderAccent, status=muted)", "info");
				return;
			}

			if (sub !== "verb" && sub !== "status") {
				if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-spinner verb <key> | status <key> | reset | preview`, "error");
				return;
			}

			const key = parts[1];
			if (!key) {
				if (ctx.hasUI) ctx.ui.notify(`Missing color key. Try /cc-spinner preview to see available keys.`, "error");
				return;
			}

			// Validate the key resolves to *some* color in the active theme;
			// accept anyway if the user insists so themes with custom keys work.
			const ansi = theme ? safeFgAnsi(theme, key) : null;
			const settingKey = sub === "verb" ? "spinnerVerbColor" : "spinnerStatusColor";
			writeSettingsKey(settingKey, key);
			bustSpinnerSettingsCache();
			if (ctx.hasUI) {
				const sample = ansi ? `${ansi}sample\x1b[39m` : "(key unmapped in current theme)";
				ctx.ui.notify(`Spinner ${sub} → ${key} ${sample}`, "info");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		clearRtkRewriteState();
		if (!ctx.hasUI) return;
		patchRtkRewriteNotifications(ctx.ui);
		// Session switch (/resume, /new) can leave tool chrome from the previous
		// theme; rebind from ctx.ui.theme (other extensions may setTheme in the
		// same tick — deferred passes pick up the final theme without coupling).
		rebindUiChromeToTheme(ctx);
		scheduleDeferredChromeRebind(ctx, 0);
		const reason = (event as { reason?: string })?.reason;
		if (reason === "resume" || reason === "new" || reason === "fork") {
			scheduleDeferredChromeRebind(ctx, 48);
			// Chat history rebuild can run after session_start; re-sync transparent tool bgs.
			scheduleDeferredChromeRebind(ctx, 120);
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		patchRtkRewriteNotifications(ctx.ui);
		applyToolBackgroundMode(ctx.ui.theme);
		applyThemePaletteIfNeeded(ctx.ui.theme);
	});

	pi.on("message_update", async (event) => {
		const content = (event as any)?.message?.content;
		const hasText = Array.isArray(content) && content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
		if (hasText) clearPreservedBashPreviews();
	});

	pi.on("tool_execution_start", async (event) => {
		clearPreservedBashPreviews();
		const toolName = (event as any)?.toolName;
		if (toolName !== "bash") return;
		trackRtkOriginalToolPreview(toolName, (event as any)?.toolCallId, (event as any)?.args);
	});

	const cwd = process.cwd();
	const sp = (path: string) => shortPath(cwd, path);

	registerReadTool({
		pi,
		cwd,
		clearBlinkTimer,
		getFirstImageBlock,
		makeText,
		NOWRAP_MARK,
		previewLimit,
		renderReadImageResult,
		runningPreviewBlock,
		safeInvalidate,
		setToolStatus,
		sp,
		stableCallSummary,
		syncToolCallStatus,
		toolHeader,
		toolOutputDetailHint,
		toolStatusDot,
	});
	registerBashTool({
		pi,
		cwd,
		bashCollapsedLimit,
		buildPersistentBashPreview,
		clearBlinkTimer,
		ensureRtkRewriteForContext,
		formatRtkRewriteDetails,
		makeText,
		preserveBashPreview,
		runningPreviewBlock,
		setToolStatus,
		shouldPreserveBashPreview,
		stableCallSummary,
		summarizeText,
		syncToolCallStatus,
		toolHeader,
		toolOutputDetailHint,
		toolStatusDot,
	});
	registerSearchTools({
		pi,
		cwd,
		clearBlinkTimer,
		collapsedPreviewCount,
		dirIcon,
		D_RST,
		FG_RULE,
		fileIcon,
		formatGroupedGrepPreview,
		formatRtkCompactionDetails,
		getGrepGroupedSummary,
		getRtkCompaction,
		makeText,
		previewLimit,
		runningPreviewBlock,
		setToolStatus,
		sp,
		stableCallSummary,
		summarizeText,
		syncToolCallStatus,
		toolHeader,
		toolOutputDetailHint,
		toolStatusDot,
	});

	registerWriteTool({
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
		toolOutputDetailHint,
		toolPathArg,
		toolStatusDot,
	});
	registerEditTool({
		pi,
		cwd,
		asyncDiff,
		clearBlinkTimer,
		formatLineMeta,
		hashText,
		hasOwnArg,
		liveBranchDisplay,
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
		toolOutputDetailHint,
		toolPathArg,
		toolStatusDot,
	});

	pi.on("session_start", async () => {
		registerOpenAiToolOverrides(pi, sp);
		registerMcpToolOverrides(pi);
	});
	pi.on("before_agent_start", async () => {
		registerOpenAiToolOverrides(pi, sp);
		registerMcpToolOverrides(pi);
	});

	// Safety net: clear all blink timers on turn/session boundaries
	pi.on("turn_end", async () => {
		for (const entry of _blinkContexts.values()) {
			entry.key._blinkActive = false;
		}
		_blinkContexts.clear();
		clearHighlightCache();
		if (_globalBlinkTimer) {
			clearTimeout(_globalBlinkTimer);
			_globalBlinkTimer = null;
		}
	});
	pi.on("session_shutdown", async () => {
		for (const entry of _blinkContexts.values()) {
			entry.key._blinkActive = false;
		}
		_blinkContexts.clear();
		clearRtkRewriteState();
		clearHighlightCache();
		invalidateThemePaletteCache();
		bumpToolBranchVisualEpoch();
		if (_globalBlinkTimer) {
			clearTimeout(_globalBlinkTimer);
			_globalBlinkTimer = null;
		}
	});
}
