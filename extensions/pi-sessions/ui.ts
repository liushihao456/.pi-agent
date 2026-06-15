// @ts-nocheck
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type SessionInfo = {
	id: string;
	name: string;
	cwd: string;
	state: string;
	status?: string;
	pid?: number | null;
	lastActivityAt?: number;
	agentStatus?: string;
	transcript?: string;
	shortName?: string;
};

type PanelActions = {
	getSessions: () => Promise<SessionInfo[]>;
	getAttached: () => string | null;
	switchTo: (name: string) => Promise<void>;
	newSession: () => Promise<void>;
	resumeSession: () => Promise<void>;
	killSession: (name: string) => Promise<void>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
};

const PARENT_SESSION_ID = "__parent__";

function isCtrl(data: string, key: "o" | "r" | "k"): boolean {
	const code = key === "o" ? "\x0f" : key === "r" ? "\x12" : "\x0b";
	return data === code || matchesKey(data, Key.ctrl(key));
}

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function renderInputChild(input: Input, width: number): string {
	const line = input.render(Math.max(1, width))[0] ?? "";
	return line.startsWith("> ") ? line.slice(2) : line;
}

function cwdBasename(cwd: string): string {
	const trimmed = cwd.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i >= 0 ? trimmed.slice(i + 1) || "/" : trimmed || "/";
}

function computeShortNames(sessions: SessionInfo[]): void {
	const counts = new Map<string, number>();
	for (const session of sessions) {
		const base = cwdBasename(session.cwd || "");
		const n = counts.get(base) ?? 0;
		counts.set(base, n + 1);
		session.shortName = n === 0 ? base : `${base}<${n}>`;
	}
}

class SessionsPanel {
	private sessions: SessionInfo[] = [];
	private selected = 0;
	private loading = true;
	private error: string | null = null;
	private closed = false;
	private readonly filterInput = new Input();
	private readonly theme: any;
	private readonly done: () => void;
	private readonly actions: PanelActions;
	private readonly requestRender: () => void;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		theme: any,
		done: () => void,
		actions: PanelActions,
		requestRender: () => void,
	) {
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.requestRender = requestRender;
		this.filterInput.focused = true;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 1200);
	}

	get focused(): boolean {
		return true;
	}

	set focused(_value: boolean) {}

	private async refresh(): Promise<void> {
		try {
			this.error = null;
			this.sessions = await this.actions.getSessions();
			computeShortNames(this.sessions);
			this.clampSelection();
		} catch (error) {
			this.error = String(error);
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private filteredSessions(): SessionInfo[] {
		const query = this.filterInput.getValue().trim().toLowerCase();
		if (!query) return this.sessions;
		return this.sessions.filter((session) =>
			[
				session.shortName,
				session.name,
				session.cwd,
				session.transcript,
				session.state,
			]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(query)),
		);
	}

	private selectedSession(): SessionInfo | null {
		return this.filteredSessions()[this.selected] || null;
	}

	private clampSelection(): void {
		const max = Math.max(0, this.filteredSessions().length - 1);
		this.selected = Math.max(0, Math.min(this.selected, max));
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (isCtrl(data, "o")) {
			void this.actions.newSession().then(() => this.close());
			return;
		}
		if (isCtrl(data, "r")) {
			void this.actions.resumeSession().then(() => this.close());
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(
				Math.max(0, this.filteredSessions().length - 1),
				this.selected + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const session = this.selectedSession();
			if (!session) return;
			void this.actions
				.switchTo(
					session.id === PARENT_SESSION_ID ? PARENT_SESSION_ID : session.name,
				)
				.then(() => this.close());
			return;
		}
		if (isCtrl(data, "k")) {
			const session = this.selectedSession();
			if (!session) return;
			if (session.id === PARENT_SESSION_ID) {
				this.actions.notify("Cannot kill parent session.", "warning");
				return;
			}
			void this.actions.killSession(session.name).then(() => this.refresh());
			return;
		}

		const before = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== before) this.selected = 0;
		this.clampSelection();
		this.requestRender();
	}

	private activity(session: SessionInfo): string {
		if (session.id === PARENT_SESSION_ID) return "idle";
		return session.agentStatus || "idle";
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (color: "accent" | "dim" = "accent") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const success = (s: string) => th.fg("success", s);
		const error = (s: string) => th.fg("error", s);
		const lines: string[] = [];
		const attached = this.actions.getAttached();
		const visibleSessions = this.filteredSessions();
		const total = Math.max(1, visibleSessions.length);
		const index = Math.min(this.selected + 1, total);
		const prefix = `${index}/${total}\tSessions: `;
		const renderedInput = renderInputChild(
			this.filterInput,
			width - visibleWidth(prefix),
		);

		lines.push(border());
		lines.push(accent(padVisible(`${prefix}${renderedInput}`, width)));
		lines.push(border("dim"));

		if (this.error) {
			lines.push(padVisible(`  ${error("error")} ${this.error}`, width));
		} else if (visibleSessions.length === 0) {
			lines.push(
				padVisible(
					`  ${dim(this.loading ? "Loading…" : "No sessions")}`,
					width,
				),
			);
		} else {
			const nameW = 25;
			const stateW = 9;
			for (let i = 0; i < visibleSessions.length; i++) {
				const session = visibleSessions[i]!;
				const selected = i === this.selected;
				const isAttached =
					session.id === PARENT_SESSION_ID
						? !attached
						: attached === session.name || attached === session.id;
				const marker = selected ? "›" : " ";
				const base = session.shortName || session.name;
				const current = isAttached ? " (current)" : "";
				const leftPlain = `${marker} ${base}${current}`;
				const tmp = selected
					? accent(`${marker} ${base}`)
					: `${marker} ${base}`;
				const styledBase = `${tmp}${dim(current)}`;
				const styledLeft = padVisible(styledBase, nameW);
				const state = this.activity(session);
				const styledState =
					state === "working"
						? success(padVisible(state, stateW))
						: dim(padVisible(state, stateW));
				const cwd = dim(
					truncateToWidth(
						session.cwd || "",
						Math.max(0, width - nameW - stateW - 24),
						"…",
					),
				);
				const transcript = dim(
					truncateToWidth(session.transcript || "", 24, "…"),
				);
				lines.push(
					padVisible(`${styledLeft}${styledState}${cwd}  ${transcript}`, width),
				);
			}
		}
		lines.push(border());
		lines.push(
			dim(
				padVisible(
					"↑↓ move · <enter> switch · <C-o> new · <C-r> resume · <C-k> kill · <esc> close",
					width,
				),
			),
		);
		return lines;
	}

	invalidate(): void {
		this.filterInput.invalidate();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}
}

export async function showSessionsPanel(
	ctx: any,
	actions: PanelActions,
): Promise<void> {
	await ctx.ui.custom(
		(tui: any, theme: any, _keybindings: any, done: () => void) =>
			new SessionsPanel(theme, done, actions, () => tui.requestRender()),
	);
}
