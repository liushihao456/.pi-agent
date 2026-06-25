// @ts-nocheck
import { isMcpToolName, renderMcpToolResult, summarizeMcpToolCall } from "./mcp";
import { renderOpenAiToolResult, summarizeOpenAiToolCall } from "./openai";

let deps: any = {};

export const CORE_TOOL_OVERRIDES = new Set(["read", "bash", "grep", "find", "ls", "write", "edit"]);

export function configureGenericToolRenderer(nextDeps: any): void {
	deps = nextDeps ?? {};
}

export function humanizeToolName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function shouldUseGenericToolRenderer(name: unknown): boolean {
	return typeof name === "string" && name.length > 0 && !CORE_TOOL_OVERRIDES.has(name);
}

function genericToolLabel(name: string): string {
	return isMcpToolName(name) ? "MCP" : humanizeToolName(name);
}

export function summarizeGenericToolCall(name: string, args: any, theme: any, sp: (path: string) => string): string {
	if (isMcpToolName(name)) return summarizeMcpToolCall(args, theme);
	return summarizeOpenAiToolCall(name, args, theme, sp);
}

export function renderGenericToolCall(name: string, args: any, theme: any, ctx: any): any {
	deps.syncToolCallStatus(ctx);
	ctx.state._openAiPatchFiles = [];
	const sp = (path: string) => deps.shortPath(ctx.cwd ?? process.cwd(), path);
	const summary = deps.stableCallSummary(ctx, "_callSummary", () => summarizeGenericToolCall(name, args, theme, sp));
	return deps.makeText(ctx.lastComponent, deps.toolHeader(genericToolLabel(name), summary, theme, deps.toolStatusDot(ctx, theme)));
}

export function renderGenericToolResult(name: string, result: any, options: any, theme: any, ctx: any): any {
	if (isMcpToolName(name)) return renderMcpToolResult(result, !!options?.expanded, !!options?.isPartial, theme, ctx);
	return renderOpenAiToolResult(name, { content: result.content, details: result.details }, !!options?.expanded, !!options?.isPartial, theme, ctx);
}
