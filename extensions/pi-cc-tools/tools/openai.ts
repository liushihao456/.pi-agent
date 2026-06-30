import { withBranch } from "../render/branch";
import { buildPreviewTextMapped } from "../render/preview";
import { extractApplyPatchFiles, renderApplyPatchCall, renderApplyPatchResult } from "./apply-patch";
import { CORE_TOOL_OVERRIDES, humanizeToolName } from "./generic";
import { isMcpToolCandidate } from "./mcp";

let deps: any = {};
const wrappedOpenAiTools = new Set<string>();

const OPENAI_STYLE_TOOL_NAMES = new Set([
	"apply_patch", "webfetch", "question", "questionnaire", "context_tag", "context_log", "context_checkout", "annotate",
	"web_search", "code_search", "fetch_content", "get_search_content", "alpha_search", "alpha_get_paper", "alpha_ask_paper",
	"alpha_annotate_paper", "alpha_list_annotations", "alpha_read_code", "Skill", "EnterPlanMode", "ExitPlanMode", "Agent",
	"get_subagent_result", "steer_subagent", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute",
]);

export function configureOpenAiToolRenderer(nextDeps: any): void {
	deps = nextDeps ?? {};
}

export function isOpenAiToolCandidate(tool: unknown): boolean {
	const rec = tool as Record<string, unknown> | undefined;
	const name = typeof rec?.name === "string" ? rec.name : "";
	if (!name || CORE_TOOL_OVERRIDES.has(name) || isMcpToolCandidate(tool)) return false;
	return OPENAI_STYLE_TOOL_NAMES.has(name);
}

function getStringArrayArg(args: any, ...keys: string[]): string[] {
	for (const key of keys) {
		const value = args?.[key];
		if (!Array.isArray(value)) continue;
		const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		if (items.length > 0) return items;
	}
	return [];
}

export function summarizeOpenAiToolCall(name: string, args: any, theme: any, sp: (path: string) => string): string {
	switch (name) {
		case "apply_patch": {
			const patchText = deps.getStringArg(args, "patchText", "patch_text");
			const files = extractApplyPatchFiles(patchText);
			if (files.length === 0) return theme.fg("muted", "patch");
			if (files.length === 1) return sp(files[0]);
			return `${sp(files[0])} ${theme.fg("muted", `(+${files.length - 1} files)`)}`;
		}
		case "webfetch": return deps.getStringArg(args, "url") || theme.fg("muted", "fetch page");
		case "fetch_content": {
			const url = deps.getStringArg(args, "url");
			if (url) return url;
			const urls = getStringArrayArg(args, "urls");
			if (urls.length === 0) return theme.fg("muted", "fetch content");
			if (urls.length === 1) return urls[0];
			return `${urls[0]} ${theme.fg("muted", `(+${urls.length - 1} urls)`)}`;
		}
		case "get_search_content": return deps.getStringArg(args, "responseId", "response_id") || theme.fg("muted", "load cached content");
		case "web_search": {
			const query = deps.getStringArg(args, "query");
			if (query) return deps.summarizeText(query, 72);
			const queries = getStringArrayArg(args, "queries");
			if (queries.length === 0) return theme.fg("muted", "search web");
			if (queries.length === 1) return deps.summarizeText(queries[0], 72);
			return `${deps.summarizeText(queries[0], 48)} ${theme.fg("muted", `(+${queries.length - 1} queries)`)}`;
		}
		case "code_search": return deps.summarizeText(deps.getStringArg(args, "query") || "search code", 72);
		case "question": return deps.summarizeText(deps.getStringArg(args, "question") || "ask user", 72);
		case "questionnaire": {
			const questions = Array.isArray(args?.questions) ? args.questions.length : 0;
			return questions > 0 ? `${questions} questions` : theme.fg("muted", "questionnaire");
		}
		case "context_tag": return deps.getStringArg(args, "name") || theme.fg("muted", "save point");
		case "context_log": return theme.fg("muted", "history");
		case "context_checkout": return deps.getStringArg(args, "target") || theme.fg("muted", "checkout context");
		case "annotate": return deps.getStringArg(args, "url") || theme.fg("muted", "current tab");
		case "alpha_search": return deps.summarizeText(deps.getStringArg(args, "query") || "search papers", 72);
		case "alpha_get_paper":
		case "alpha_ask_paper":
		case "alpha_annotate_paper": return deps.getStringArg(args, "paper") || theme.fg("muted", "paper");
		case "alpha_read_code": return deps.getStringArg(args, "githubUrl", "github_url") || theme.fg("muted", "repository");
		case "Skill": return deps.getStringArg(args, "name") || theme.fg("muted", "run skill");
		case "EnterPlanMode": return theme.fg("muted", "enable read-only planning");
		case "ExitPlanMode": return theme.fg("muted", "present plan");
		case "Agent": return deps.summarizeText(deps.getStringArg(args, "description", "prompt") || "launch agent", 72);
		case "get_subagent_result": return deps.getStringArg(args, "agent_id") || theme.fg("muted", "agent result");
		case "steer_subagent": return deps.getStringArg(args, "agent_id") || theme.fg("muted", "steer agent");
		case "TaskCreate": return deps.summarizeText(deps.getStringArg(args, "subject") || "create task", 72);
		case "TaskList": return theme.fg("muted", "task list");
		case "TaskGet":
		case "TaskUpdate": return deps.getStringArg(args, "taskId", "task_id") || theme.fg("muted", "task");
		case "TaskOutput":
		case "TaskStop": return deps.getStringArg(args, "task_id", "taskId") || theme.fg("muted", "background task");
		case "TaskExecute": {
			const taskIds = getStringArrayArg(args, "task_ids", "taskIds");
			if (taskIds.length === 0) return theme.fg("muted", "start tasks");
			return taskIds.length === 1 ? taskIds[0] : `${taskIds[0]} ${theme.fg("muted", `(+${taskIds.length - 1} tasks)`)}`;
		}
		default:
			return deps.summarizeText(deps.getStringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt") || humanizeToolName(name), 72);
	}
}

interface ParsedTaskListLine { id: string; status: string; subject: string; }
function parseTaskListLine(line: string): ParsedTaskListLine | null {
	const match = line.match(/^#(\d+) \[([^\]]+)\] (.+)$/);
	if (!match) return null;
	return { id: match[1], status: match[2], subject: match[3] };
}
function formatTaskStatus(status: string, theme: any): string {
	if (status === "completed") return theme.fg("success", status);
	if (status === "in_progress") return theme.fg("warning", status);
	return theme.fg("muted", status);
}
function formatOpenAiSuccessLine(name: string, line: string, theme: any): string {
	const trimmed = line.trim();
	if (!trimmed) return theme.fg("success", "Done");
	if (name === "TaskCreate") {
		const match = trimmed.match(/^Task #(\d+) created successfully: (.+)$/);
		if (match) return `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	}
	if (name === "TaskUpdate") {
		const match = trimmed.match(/^Updated task #(\d+) (.+)$/);
		if (match) return `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	}
	if (name === "TaskExecute") return `${theme.fg("success", "Started")} ${theme.fg("muted", trimmed)}`;
	if (name === "context_tag") {
		const match = trimmed.match(/^Created tag '([^']+)' at (.+)$/);
		if (match) return `${theme.fg("success", "Created tag")} ${theme.fg("accent", match[1])} ${theme.fg("muted", match[2])}`;
	}
	if (name === "context_checkout") return `${theme.fg("success", "Checked out")} ${theme.fg("muted", trimmed.replace(/^Checked out\s*/i, ""))}`;
	if (name === "TaskStop") return `${theme.fg("success", "Stopped")} ${theme.fg("muted", trimmed)}`;
	return theme.fg("muted", trimmed);
}
function renderTaskListResult(lines: string[], expanded: boolean, theme: any, ctx: any): any {
	const tasks = lines.map(parseTaskListLine).filter((task): task is ParsedTaskListLine => task !== null);
	if (tasks.length === 0) {
		const text = lines.length === 0 ? theme.fg("muted", "no tasks") : buildPreviewTextMapped(lines, expanded, theme, deps.previewLimit(), (line: string) => theme.fg("dim", line));
		return deps.makeText(ctx.lastComponent, withBranch(text, theme));
	}
	const pending = tasks.filter((task) => task.status === "pending").length;
	const inProgress = tasks.filter((task) => task.status === "in_progress").length;
	const completed = tasks.filter((task) => task.status === "completed").length;
	let summary = theme.fg("muted", `${tasks.length} tasks`);
	const parts: string[] = [];
	if (inProgress > 0) parts.push(`${theme.fg("warning", String(inProgress))} in progress`);
	if (pending > 0) parts.push(`${theme.fg("muted", String(pending))} pending`);
	if (completed > 0) parts.push(`${theme.fg("success", String(completed))} completed`);
	if (parts.length > 0) summary += ` ${theme.fg("muted", "•")} ${parts.join(` ${theme.fg("muted", "•")} `)}`;
	if (!expanded) return deps.makeText(ctx.lastComponent, withBranch(`${summary}${deps.toolOutputDetailHint(theme, expanded)}`, theme));
	const shown = tasks.slice(0, deps.previewLimit());
	const preview = shown.map((task) => `${theme.fg("accent", `#${task.id}`)} ${formatTaskStatus(task.status, theme)} ${theme.fg("dim", task.subject)}`);
	const remaining = tasks.length - shown.length;
	if (remaining > 0) preview.push(theme.fg("muted", `… ${remaining} more tasks`));
	return deps.makeText(ctx.lastComponent, withBranch(`${summary}\n${preview.join("\n")}`, theme));
}

export function renderOpenAiToolResult(name: string, result: any, expanded: boolean, isPartial: boolean, theme: any, ctx: any): any {
	if (isPartial) return deps.makeText(ctx.lastComponent, deps.runningPreviewBlock(result, theme.fg("dim", `${humanizeToolName(name)}...`), expanded, theme, ctx));
	deps.clearBlinkTimer(ctx);
	deps.setToolStatus(ctx, ctx.isError ? "error" : "success");
	const raw = deps.getTextContent(result).trim();
	const lines = raw ? raw.split("\n") : [];
	const patchFiles = Array.isArray(ctx.state?._openAiPatchFiles) ? ctx.state._openAiPatchFiles : [];
	if (lines.length === 0) {
		if (patchFiles.length > 0) {
			const suffix = patchFiles.length === 1 ? patchFiles[0] : `${patchFiles.length} files`;
			return deps.makeText(ctx.lastComponent, withBranch(`${theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Applied")} ${theme.fg("muted", suffix)}`, theme));
		}
		return deps.makeText(ctx.lastComponent, withBranch(theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Done"), theme));
	}
	if (!ctx.isError && name === "TaskList") return renderTaskListResult(lines, expanded, theme, ctx);
	const statusText = ctx.isError ? theme.fg("error", lines[0]) : theme.fg("muted", `${lines.length} line${lines.length === 1 ? "" : "s"} returned`);
	if (!expanded) return deps.makeText(ctx.lastComponent, withBranch(`${statusText}${deps.toolOutputDetailHint(theme, expanded)}`, theme));
	if (!ctx.isError && lines.length === 1) return deps.makeText(ctx.lastComponent, withBranch(formatOpenAiSuccessLine(name, lines[0], theme), theme));
	const preview = lines.length === 1 ? theme.fg(ctx.isError ? "error" : "dim", lines[0]) : buildPreviewTextMapped(lines, true, theme, deps.previewLimit(), (line: string) => theme.fg(ctx.isError ? "error" : "dim", line || " "));
	return deps.makeText(ctx.lastComponent, withBranch(`${statusText}\n${preview}`, theme));
}

export function registerOpenAiToolOverrides(pi: any, sp: (path: string) => string): void {
	let allTools: unknown[] = [];
	try { allTools = typeof pi.getAllTools === "function" ? pi.getAllTools() : []; } catch { allTools = []; }
	for (const tool of allTools) {
		if (!isOpenAiToolCandidate(tool)) continue;
		const record = tool as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : "";
		if (!name || wrappedOpenAiTools.has(name)) continue;
		const execute = typeof record.execute === "function" ? (record.execute as any) : null;
		if (!execute) continue;
		const rawLabel = typeof record.label === "string" ? record.label.trim() : "";
		const label = rawLabel && rawLabel !== name && !rawLabel.includes("_") ? rawLabel : humanizeToolName(name);
		const description = typeof record.description === "string" ? record.description : label;
		pi.registerTool({
			name, label, description, parameters: record.parameters,
			prepareArguments: typeof record.prepareArguments === "function" ? record.prepareArguments : undefined,
			async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
				return await Promise.resolve(execute(toolCallId, params, signal, onUpdate, ctx));
			},
			renderCall(args: any, theme: any, ctx: any) {
				if (name === "apply_patch") return renderApplyPatchCall(args, theme, ctx, sp);
				deps.syncToolCallStatus(ctx);
				ctx.state._openAiPatchFiles = [];
				const summary = deps.stableCallSummary(ctx, "_callSummary", () => summarizeOpenAiToolCall(name, args, theme, sp));
				return deps.makeText(ctx.lastComponent, deps.toolHeader(label, summary, theme, deps.toolStatusDot(ctx, theme)));
			},
			renderResult(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
				if (name === "apply_patch") return renderApplyPatchResult(result, isPartial, theme, ctx);
				return renderOpenAiToolResult(name, result, expanded, isPartial, theme, ctx);
			},
		});
		wrappedOpenAiTools.add(name);
	}
}
