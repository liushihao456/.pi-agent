import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionInfo,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type ProjectGroup = {
	name: string;
	path: string;
	displayPath: string;
	sessions: SessionInfo[];
	modified: Date;
};

type PickerAction =
	| { type: "cancel" }
	| { type: "open-folder" }
	| { type: "new-session"; cwd: string }
	| { type: "switch-session"; sessionPath: string };

const MODE_PROJECTS = "projects";
const MODE_SESSIONS = "sessions";
const MAX_VISIBLE_ITEMS = 5;
type Mode = typeof MODE_PROJECTS | typeof MODE_SESSIONS;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

function normalizeExistingDir(input: string): string | null {
	try {
		const expanded = expandHome(input.trim());
		if (!expanded) return null;
		const absolute = path.resolve(expanded);
		if (!existsSync(absolute)) return null;
		if (!statSync(absolute).isDirectory()) return null;
		return realpathSync(absolute);
	} catch {
		return null;
	}
}

function displayPath(filePath: string): string {
	const home = homedir();
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}${path.sep}`))
		return `~/${path.relative(home, filePath)}`;
	return filePath;
}

function projectName(filePath: string): string {
	return path.basename(filePath) || filePath;
}

function relativeTime(date: Date): string {
	const ms = Date.now() - date.getTime();
	if (!Number.isFinite(ms) || ms < 0) return "now";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return "now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h ago`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day}d ago`;
	const month = Math.floor(day / 30);
	if (month < 12) return `${month}mo ago`;
	return `${Math.floor(month / 12)}y ago`;
}

function sessionTitle(session: SessionInfo): string {
	const title =
		session.name?.trim() ||
		session.firstMessage?.trim() ||
		session.id.slice(0, 8);
	return title.replace(/\s+/g, " ");
}

function safeLower(value: string): string {
	return value.toLowerCase();
}

function makeProjects(sessions: SessionInfo[]): ProjectGroup[] {
	const groups = new Map<string, SessionInfo[]>();

	for (const session of sessions) {
		const cwd = session.cwd ? normalizeExistingDir(session.cwd) : null;
		if (!cwd) continue;
		const list = groups.get(cwd) ?? [];
		list.push(session);
		groups.set(cwd, list);
	}

	return [...groups.entries()]
		.map(([cwd, projectSessions]) => {
			const sorted = [...projectSessions].sort(
				(a, b) => b.modified.getTime() - a.modified.getTime(),
			);
			return {
				name: projectName(cwd),
				path: cwd,
				displayPath: displayPath(cwd),
				sessions: sorted,
				modified: sorted[0]?.modified ?? new Date(0),
			} satisfies ProjectGroup;
		})
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function fits(width: number, text: string): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function indent(width: number, text: string): string {
	return fits(width, `  ${text}`);
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

class ProjectSessionPicker {
	private mode: Mode = MODE_PROJECTS;
	private selectedProjectIndex = 0;
	private selectedSessionIndex = 0;
	private search = "";
	private activeProject: ProjectGroup | null = null;
	private readonly projects: ProjectGroup[];
	private readonly theme: Theme;
	private readonly done: (action: PickerAction) => void;
	private readonly requestRender: () => void;

	constructor(
		projects: ProjectGroup[],
		theme: Theme,
		done: (action: PickerAction) => void,
		requestRender: () => void,
	) {
		this.projects = projects;
		this.theme = theme;
		this.done = done;
		this.requestRender = requestRender;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.border(width));
		lines.push(this.header(width));
		lines.push(this.border(width, "", "dim"));

		if (this.mode === MODE_PROJECTS) this.renderProjects(lines, width);
		else this.renderSessions(lines, width);

		lines.push(this.border(width));
		lines.push(this.footer(width));
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.done({ type: "cancel" });
			return;
		}

		this.handleNormalInput(data);
	}

	private handleNormalInput(data: string): void {
		if (this.handleNavigationInput(data)) return;
		if (this.handleShortcutInput(data)) return;
		this.handlePrintableInput(data);
	}

	private handleNavigationInput(data: string): boolean {
		if (matchesKey(data, Key.escape))
			return this.runHandled(() => this.backOrCancel());
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")))
			return this.runHandled(() => this.move(-1));
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")))
			return this.runHandled(() => this.move(1));
		if (matchesKey(data, Key.enter))
			return this.runHandled(() => this.selectCurrent());
		return false;
	}

	private handleShortcutInput(data: string): boolean {
		if (this.mode === MODE_PROJECTS && matchesKey(data, Key.ctrl("o")))
			return this.runHandled(() => this.done({ type: "open-folder" }));
		if (this.mode === MODE_SESSIONS && matchesKey(data, Key.ctrl("o")))
			return this.runHandled(() => this.newSessionForSelectedProject());
		if (matchesKey(data, Key.backspace))
			return this.runHandled(() => this.popSearch());
		return false;
	}

	private handlePrintableInput(data: string): void {
		if (isPrintable(data)) this.pushSearch(data);
	}

	private runHandled(action: () => void): boolean {
		action();
		return true;
	}

	private backOrCancel(): void {
		if (this.mode === MODE_SESSIONS) {
			this.mode = MODE_PROJECTS;
			this.search = "";
			this.activeProject = null;
			this.selectedSessionIndex = 0;
			this.requestRender();
			return;
		}
		this.done({ type: "cancel" });
	}

	private pushSearch(input: string): void {
		this.search += input;
		this.clampSelection();
		this.requestRender();
	}

	private popSearch(): void {
		this.search = this.search.slice(0, -1);
		this.clampSelection();
		this.requestRender();
	}

	private newSessionForSelectedProject(): void {
		if (this.activeProject)
			this.done({ type: "new-session", cwd: this.activeProject.path });
	}

	private border(
		width: number,
		label = "",
		color: "accent" | "dim" = "accent",
	): string {
		const plain = `─${label}`;
		const fill = "─".repeat(Math.max(0, width - visibleWidth(plain)));
		return this.theme.fg(color, `${plain}${fill}`);
	}

	private header(width: number): string {
		const index = this.currentIndex() + 1;
		const total = this.currentTotal();
		const prompt =
			this.mode === MODE_PROJECTS
				? "Select project:"
				: `Select ${this.activeProject?.name ?? "project"} session:`;
		return this.theme.fg(
			"accent",
			fits(width, `${index}/${total}  ${prompt} ${this.search}`),
		);
	}

	private currentIndex(): number {
		return this.mode === MODE_PROJECTS
			? this.selectedProjectIndex
			: this.selectedSessionIndex;
	}

	private currentTotal(): number {
		if (this.mode === MODE_PROJECTS) return this.filteredProjects().length + 1;
		return this.activeProject
			? this.filteredSessions(this.activeProject).length + 1
			: 1;
	}

	private footer(width: number): string {
		const text =
			this.mode === MODE_PROJECTS
				? "↑↓/C-p C-n move · type search · enter choose · C-o open folder · esc cancel"
				: "↑↓/C-p C-n move · type search · enter switch · C-o new session · esc back";
		return this.theme.fg("dim", fits(width, text));
	}

	private itemLine(
		width: number,
		left: string,
		right: string,
		options: { selected: boolean },
	): string {
		const rightWidth = Math.min(
			visibleWidth(right),
			Math.max(0, Math.floor(width * 0.55)),
		);
		const renderedRight = fits(rightWidth, right);
		const renderedLeft = fits(
			Math.max(0, width - visibleWidth(renderedRight) - 1),
			left,
		);
		const gap = " ".repeat(
			Math.max(
				1,
				width - visibleWidth(renderedLeft) - visibleWidth(renderedRight),
			),
		);
		const styledLeft = options.selected
			? this.theme.fg("accent", renderedLeft)
			: renderedLeft;
		return `${styledLeft}${gap}${this.theme.fg("dim", renderedRight)}`;
	}

	private renderProjects(lines: string[], width: number): void {
		const projects = this.filteredProjects();
		let rendered = 0;
		if (projects.length === 0) {
			lines.push(
				this.theme.fg("dim", indent(width, "No projects from sessions.")),
			);
			rendered++;
		}

		const total = projects.length + 1;
		const start = this.visibleStart(total, this.selectedProjectIndex);
		const end = Math.min(total, start + MAX_VISIBLE_ITEMS - rendered);
		for (let i = start; i < end; i++) {
			lines.push(this.projectRow(width, projects, i));
			rendered++;
		}
		this.padVisibleRows(lines, width, rendered);
	}

	private renderSessions(lines: string[], width: number): void {
		const project = this.activeProject;
		if (!project) {
			lines.push(this.theme.fg("dim", indent(width, "Project missing.")));
			this.padVisibleRows(lines, width, 1);
			return;
		}

		const sessions = this.filteredSessions(project);
		const total = sessions.length + 1;
		this.selectedSessionIndex = Math.max(
			0,
			Math.min(this.selectedSessionIndex, total - 1),
		);

		let rendered = 0;
		const start = this.visibleStart(total, this.selectedSessionIndex);
		const end = Math.min(total, start + MAX_VISIBLE_ITEMS);
		for (let i = start; i < end; i++) {
			lines.push(this.sessionRow(width, project, sessions, i));
			rendered++;
		}
		if (sessions.length === 0 && rendered < MAX_VISIBLE_ITEMS) {
			lines.push(
				this.theme.fg("dim", indent(width, "No sessions for project.")),
			);
			rendered++;
		}
		this.padVisibleRows(lines, width, rendered);
	}

	private projectRow(
		width: number,
		projects: ProjectGroup[],
		index: number,
	): string {
		if (index === projects.length) {
			const selected = this.selectedProjectIndex === index;
			return this.itemLine(
				width,
				`${selected ? "›" : " "} + Open Folder…`,
				"create new session from directory path",
				{ selected },
			);
		}

		const project = projects[index]!;
		const selected = index === this.selectedProjectIndex;
		const marker = selected ? "›" : " ";
		const title = `${marker} ${project.name}`;
		const meta = `${project.displayPath} · ${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"} · ${relativeTime(project.modified)}`;
		return this.itemLine(width, title, meta, { selected });
	}

	private sessionRow(
		width: number,
		project: ProjectGroup,
		sessions: SessionInfo[],
		index: number,
	): string {
		if (index === 0) {
			const selected = this.selectedSessionIndex === 0;
			return this.itemLine(
				width,
				`${selected ? "›" : " "} + New Session`,
				`cwd ${project.displayPath}`,
				{ selected },
			);
		}

		const session = sessions[index - 1]!;
		const selected = index === this.selectedSessionIndex;
		const marker = selected ? "›" : " ";
		const title = `${marker} ${sessionTitle(session)}`;
		const meta = `${session.messageCount} msgs · ${relativeTime(session.modified)}`;
		return this.itemLine(width, title, meta, { selected });
	}

	private visibleStart(total: number, selected: number): number {
		if (total <= MAX_VISIBLE_ITEMS) return 0;
		const half = Math.floor(MAX_VISIBLE_ITEMS / 2);
		return Math.min(Math.max(0, selected - half), total - MAX_VISIBLE_ITEMS);
	}

	private padVisibleRows(
		lines: string[],
		width: number,
		rendered: number,
	): void {
		for (let i = rendered; i < MAX_VISIBLE_ITEMS; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private filteredProjects(): ProjectGroup[] {
		const query = safeLower(this.search.trim());
		if (!query) return this.projects;
		return this.projects.filter((project) => {
			const haystack = safeLower(
				`${project.name} ${project.path} ${project.displayPath}`,
			);
			return haystack.includes(query);
		});
	}

	private filteredSessions(project: ProjectGroup): SessionInfo[] {
		const query = safeLower(this.search.trim());
		if (!query) return project.sessions;
		return project.sessions.filter((session) => {
			const haystack = safeLower(
				`${sessionTitle(session)} ${session.firstMessage} ${session.name ?? ""} ${session.path}`,
			);
			return haystack.includes(query);
		});
	}

	private move(delta: number): void {
		if (this.mode === MODE_PROJECTS) {
			const count = this.filteredProjects().length + 1;
			this.selectedProjectIndex =
				(this.selectedProjectIndex + delta + count) % count;
		} else {
			const count = this.activeProject
				? this.filteredSessions(this.activeProject).length + 1
				: 1;
			this.selectedSessionIndex =
				(this.selectedSessionIndex + delta + count) % count;
		}
		this.requestRender();
	}

	private selectCurrent(): void {
		if (this.mode === MODE_PROJECTS) {
			const projects = this.filteredProjects();
			if (this.selectedProjectIndex === projects.length) {
				this.done({ type: "open-folder" });
				return;
			}
			this.activeProject = projects[this.selectedProjectIndex]!;
			this.mode = MODE_SESSIONS;
			this.search = "";
			this.selectedSessionIndex = 0;
			this.requestRender();
			return;
		}

		const project = this.activeProject;
		if (!project) return;
		if (this.selectedSessionIndex === 0) {
			this.done({ type: "new-session", cwd: project.path });
			return;
		}
		const session =
			this.filteredSessions(project)[this.selectedSessionIndex - 1];
		if (session)
			this.done({ type: "switch-session", sessionPath: session.path });
	}

	private clampSelection(): void {
		const projects = this.filteredProjects();
		this.selectedProjectIndex = Math.max(
			0,
			Math.min(this.selectedProjectIndex, projects.length),
		);
		if (this.mode === MODE_SESSIONS) {
			const count = this.activeProject
				? this.filteredSessions(this.activeProject).length + 1
				: 1;
			this.selectedSessionIndex = Math.max(
				0,
				Math.min(this.selectedSessionIndex, count - 1),
			);
		}
	}
}

async function showPicker(
	ctx: ExtensionCommandContext,
	projects: ProjectGroup[],
): Promise<PickerAction> {
	if (!ctx.hasUI) return { type: "cancel" };
	return (
		(await ctx.ui.custom<PickerAction>((tui, theme, _keybindings, done) => {
			const picker = new ProjectSessionPicker(projects, theme, done, () =>
				tui.requestRender(),
			);
			return picker;
		})) ?? { type: "cancel" }
	);
}

async function createAndSwitch(
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const sessionManager = SessionManager.create(cwd);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("Could not create persisted session", "error");
		return;
	}
	await ctx.switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			nextCtx.ui.notify(`Switched to ${displayPath(cwd)}`, "info");
		},
	});
}

async function openFolder(ctx: ExtensionCommandContext): Promise<void> {
	const input = await ctx.ui.input("Open folder", ctx.cwd || process.cwd());
	if (input === undefined) return;
	const cwd = normalizeExistingDir(input);
	if (!cwd) {
		ctx.ui.notify("Folder does not exist or is not a directory", "error");
		return;
	}
	await createAndSwitch(ctx, cwd);
}

export default function piProject(pi: ExtensionAPI) {
	pi.registerCommand("project", {
		description: "Switch project by choosing sessions grouped by cwd",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.waitForIdle();
			const sessions = await SessionManager.listAll();
			const projects = makeProjects(sessions);
			const action = await showPicker(ctx, projects);

			if (action.type === "cancel") return;
			if (action.type === "open-folder") {
				await openFolder(ctx);
				return;
			}
			if (action.type === "new-session") {
				await createAndSwitch(ctx, action.cwd);
				return;
			}
			if (action.type === "switch-session") {
				await ctx.switchSession(action.sessionPath, {
					withSession: async (nextCtx) => {
						nextCtx.ui.notify("Switched session", "info");
					},
				});
			}
		},
	});
}
