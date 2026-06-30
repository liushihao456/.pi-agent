import { withBranch } from "../render/branch";
import { buildPreviewTextMapped } from "../render/preview";

let deps: any = {};
const wrappedMcpTools = new Set<string>();

export function configureMcpToolRenderer(nextDeps: any): void {
	deps = nextDeps ?? {};
}

export function isMcpToolCandidate(tool: unknown): boolean {
	const rec = tool as Record<string, unknown> | undefined;
	const name = typeof rec?.name === "string" ? rec.name : "";
	const description = typeof rec?.description === "string" ? rec.description : "";
	return name === "mcp" || /\bmcp\b/i.test(description);
}

export function isMcpToolName(name: string): boolean {
	return name === "mcp" || /^mcp[_:-]/i.test(name) || /[_:-]mcp[_:-]/i.test(name);
}

export function summarizeMcpToolCall(args: any, theme: any): string {
	const tool = deps.getStringArg(args, "tool");
	if (tool) return args?.server ? `${args.server}:${tool}` : tool;
	const connect = deps.getStringArg(args, "connect");
	if (connect) return `connect ${connect}`;
	const search = deps.getStringArg(args, "search", "describe", "server", "action");
	if (search) return deps.summarizeText(search, 72);
	return theme.fg("muted", "status");
}

export function renderMcpToolResult(result: any, expanded: boolean, isPartial: boolean, theme: any, ctx: any): any {
	if (isPartial) {
		return deps.makeText(ctx.lastComponent, deps.runningPreviewBlock(result, theme.fg("dim", "MCP running..."), expanded, theme, ctx, {
			styleLine: (line: string) => theme.fg("toolOutput", line || " "),
		}));
	}
	deps.clearBlinkTimer(ctx);
	deps.setToolStatus(ctx, ctx.isError ? "error" : "success");

	const mode = deps.getMode(deps.readSettings().mcpOutputMode, ["hidden", "summary", "preview"] as const, "preview");
	if (mode === "hidden") return deps.makeText(ctx.lastComponent, "");

	const raw = deps.getTextContent(result).trim();
	const lines = raw ? raw.split("\n") : [];
	if (lines.length === 0) {
		return deps.makeText(ctx.lastComponent, withBranch(theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Done"), theme));
	}

	const statusText = ctx.isError ? theme.fg("error", lines[0]) : theme.fg("muted", `${lines.length} line${lines.length === 1 ? "" : "s"} returned`);
	if (mode === "summary") return deps.makeText(ctx.lastComponent, withBranch(statusText, theme));
	if (!expanded) return deps.makeText(ctx.lastComponent, withBranch(`${statusText}${deps.toolOutputDetailHint(theme, expanded)}`, theme));
	const preview = buildPreviewTextMapped(lines, true, theme, deps.previewLimit(), (line: string) => theme.fg(ctx.isError ? "error" : "toolOutput", line || " "));
	return deps.makeText(ctx.lastComponent, withBranch(`${statusText}\n${preview}`, theme));
}

export function registerMcpToolOverrides(pi: any): void {
	let allTools: unknown[] = [];
	try { allTools = typeof pi.getAllTools === "function" ? pi.getAllTools() : []; } catch { allTools = []; }
	for (const tool of allTools) {
		if (!isMcpToolCandidate(tool)) continue;
		const record = tool as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : "";
		if (!name || wrappedMcpTools.has(name)) continue;
		const execute = typeof record.execute === "function" ? (record.execute as any) : null;
		if (!execute) continue;
		const label = typeof record.label === "string" ? record.label : name === "mcp" ? "MCP" : `MCP ${name}`;
		const description = typeof record.description === "string" ? record.description : "MCP tool";
		pi.registerTool({
			name,
			label,
			description,
			parameters: record.parameters,
			prepareArguments: typeof record.prepareArguments === "function" ? record.prepareArguments : undefined,
			async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
				return await Promise.resolve(execute(toolCallId, params, signal, onUpdate, ctx));
			},
			renderCall(args: any, theme: any, ctx: any) {
				return deps.renderGenericToolCall(name, args, theme, ctx);
			},
			renderResult(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
				return renderMcpToolResult(result, expanded, isPartial, theme, ctx);
			},
		});
		wrappedMcpTools.add(name);
	}
}
