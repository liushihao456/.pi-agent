export const CORE_TOOL_OVERRIDES = new Set(["read", "bash", "grep", "find", "ls", "write", "edit"]);

export function humanizeToolName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

let deps: any = {};

type GenericToolRendererDeps = {
	isMcpToolName: (name: string) => boolean;
	renderMcpToolResult: (result: any, expanded: boolean, isPartial: boolean, theme: any, ctx: any) => any;
	summarizeMcpToolCall: (args: any, theme: any) => string;
	renderOpenAiToolResult: (name: string, result: any, expanded: boolean, isPartial: boolean, theme: any, ctx: any) => any;
	summarizeOpenAiToolCall: (name: string, args: any, theme: any, sp: (path: string) => string) => string;
	makeText: (...args: any[]) => any;
	shortPath: (cwd: string, path: string) => string;
	stableCallSummary: (...args: any[]) => string;
	syncToolCallStatus: (ctx: any) => void;
	toolHeader: (...args: any[]) => string;
	toolStatusDot: (ctx: any, theme: any) => string;
};

export function configureGenericToolRenderer(nextDeps: Partial<GenericToolRendererDeps>): void {
	deps = nextDeps ?? {};
}

export function shouldUseGenericToolRenderer(name: unknown): boolean {
	return typeof name === "string" && name.length > 0 && !CORE_TOOL_OVERRIDES.has(name);
}

function genericToolLabel(name: string): string {
	return deps.isMcpToolName?.(name) ? "MCP" : humanizeToolName(name);
}

export function summarizeGenericToolCall(name: string, args: any, theme: any, sp: (path: string) => string): string {
	if (deps.isMcpToolName?.(name)) return deps.summarizeMcpToolCall(args, theme);
	return deps.summarizeOpenAiToolCall(name, args, theme, sp);
}

export function renderGenericToolCall(name: string, args: any, theme: any, ctx: any): any {
	deps.syncToolCallStatus(ctx);
	ctx.state._openAiPatchFiles = [];
	const sp = (path: string) => deps.shortPath(ctx.cwd ?? process.cwd(), path);
	const summary = deps.stableCallSummary(ctx, "_callSummary", () => summarizeGenericToolCall(name, args, theme, sp));
	return deps.makeText(ctx.lastComponent, deps.toolHeader(genericToolLabel(name), summary, theme, deps.toolStatusDot(ctx, theme)));
}

export function renderGenericToolResult(name: string, result: any, options: any, theme: any, ctx: any): any {
	if (deps.isMcpToolName?.(name)) return deps.renderMcpToolResult(result, !!options?.expanded, !!options?.isPartial, theme, ctx);
	return deps.renderOpenAiToolResult(name, { content: result.content, details: result.details }, !!options?.expanded, !!options?.isPartial, theme, ctx);
}
