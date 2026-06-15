// @ts-nocheck
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@homebridge/node-pty-prebuilt-multiarch";
import { showSessionsPanel } from "./ui.ts";

function readFirstMessage(filePath: string): string {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg || msg.role !== "user") continue;
				const text =
					typeof msg.content === "string"
						? msg.content
						: Array.isArray(msg.content)
							? msg.content
									.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join(" ")
							: "";
				if (text.trim()) return text.trim().slice(0, 200);
			} catch {}
		}
	} catch {}
	return "";
}

function resolveTranscriptName(
	sessionName: string | undefined,
	sessionFile: string | undefined,
): string {
	if (sessionName) return sessionName;
	if (sessionFile) return readFirstMessage(sessionFile);
	return "";
}

type ExtensionAPI = any;
type CommandContext = any;

type SessionInfo = {
	id: string;
	name: string;
	cwd: string;
	state: string;
	status?: string;
	pid?: number | null;
	lastActivityAt?: number;
	cols?: number;
	rows?: number;
};

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.join(extensionDir, "worker-guard.ts");
const dataDir = path.join(os.homedir(), ".pi", "agent", "pi-sessions");
const bridgeSocketPath = path.join(dataDir, `bridge-${process.pid}.sock`);
const sessions = new Map<string, any>();
const locks = new Map<string, { sessionId: string; acquiredAt: number }>();
let bridgeServer: net.Server | null = null;
let attachedSession: string | null = null;
const state = { parentCwd: process.cwd(), parentTranscript: "" };

const PARENT_SESSION_ID = "__parent__";

function parseArgs(args: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(args)))
		out.push(match[1] ?? match[2] ?? match[3] ?? "");
	return out;
}

function sanitizeName(name: string): string {
	return (
		String(name || "")
			.trim()
			.replace(/[^a-zA-Z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || `session-${Date.now().toString(36)}`
	);
}

function findPiCommand(): string {
	for (const candidate of [
		process.env.PI_SESSIONS_PI_BIN,
		"/opt/homebrew/bin/pi",
		"/usr/local/bin/pi",
	].filter(Boolean)) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {}
	}
	return "pi";
}

function findSession(nameOrId: string | null | undefined): any | null {
	if (!nameOrId) return null;
	return (
		sessions.get(nameOrId) ||
		[...sessions.values()].find((s) => s.name === nameOrId) ||
		null
	);
}

function publicSession(s: any): SessionInfo {
	return {
		id: s.id,
		name: s.name,
		cwd: s.cwd,
		state: s.state,
		status: s.status,
		pid: s.pty?.pid ?? null,
		lastActivityAt: s.lastActivityAt,
		agentStatus: s.agentStatus || "idle",
		cols: s.cols,
		rows: s.rows,
		transcript: s.transcript || "",
	};
}

function formatSession(s: SessionInfo): string {
	const active =
		attachedSession && (attachedSession === s.name || attachedSession === s.id)
			? "*"
			: " ";
	return `${active} ${s.name.padEnd(16)} ${String(s.state).padEnd(10)} pid:${s.pid ?? "?"} ${s.status || ""}`;
}

function notifySession(s: any): void {
	for (const cb of [...s.subscribers]) {
		try {
			cb();
		} catch {}
	}
}

function createSession(opts: {
	name: string;
	cwd: string;
	resume?: boolean;
	cols?: number;
	rows?: number;
}): SessionInfo {
	const name = sanitizeName(opts.name);
	if (
		[...sessions.values()].some(
			(s) => s.name === name && !["stopped", "error"].includes(s.state),
		)
	)
		throw new Error(`session already exists: ${name}`);
	const id = `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	const cwd = opts.cwd || process.cwd();
	const cols = Number(opts.cols || 120);
	const rows = Number(opts.rows || 40);
	const args = opts.resume
		? ["--resume", "-e", guardPath]
		: ["--name", name, "-e", guardPath];
	const env = {
		...process.env,
		PI_SESSIONS_CHILD: "1",
		PI_SESSIONS_SESSION_ID: id,
		PI_SESSIONS_SESSION_NAME: name,
		PI_SESSIONS_BRIDGE_SOCKET: bridgeSocketPath,
		PI_SESSIONS_PARENT_CWD: state.parentCwd,
		TERM: process.env.TERM || "xterm-256color",
	};
	const proc = pty.spawn(findPiCommand(), args, {
		cwd,
		env,
		cols,
		rows,
		name: "xterm-256color",
	});
	const s = {
		id,
		name,
		cwd,
		state: "running",
		status: "running",
		lastActivityAt: Date.now(),
		agentStatus: "idle" as string,
		transcript: "",
		pty: proc,
		cols,
		rows,
		replay: "",
		subscribers: new Set<() => void>(),
	};
	sessions.set(id, s);
	proc.onData((data: string) => {
		s.lastActivityAt = Date.now();
		s.replay = (s.replay + data).slice(-200_000);
	});
	proc.onExit(({ exitCode, signal }: any) => {
		releaseLocks(id);
		s.state = s.expectedStop || exitCode === 0 ? "stopped" : "error";
		s.status = s.expectedStop
			? "stopped"
			: `exited ${exitCode}${signal ? ` ${signal}` : ""}`;
		if (attachedSession === s.name || attachedSession === s.id) {
			attachedSession = null;
			for (const session of sessions.values()) notifySession(session);
			return;
		}
		notifySession(s);
	});
	return publicSession(s);
}

function stopSession(nameOrId: string): SessionInfo {
	const s = findSession(nameOrId);
	if (!s) throw new Error("session not found");
	const info = publicSession(s);
	s.expectedStop = true;
	releaseLocks(s.id);
	sessions.delete(s.id);
	if (attachedSession === s.name || attachedSession === s.id)
		attachedSession = null;
	s.pty?.kill("SIGTERM");
	notifySession(s);
	return info;
}

function resizeSession(nameOrId: string, cols: number, rows: number): void {
	const s = findSession(nameOrId);
	if (!s) return;
	cols = Math.max(20, Number(cols || s.cols));
	rows = Math.max(5, Number(rows || s.rows));
	if (cols === s.cols && rows === s.rows) return;
	s.cols = cols;
	s.rows = rows;
	s.pty?.resize(cols, rows);
}

function normalizeLockPath(p: string, cwd: string): string | null {
	if (!p || typeof p !== "string") return null;
	return path.resolve(cwd || process.cwd(), p);
}

function pathsConflict(a: string, b: string): boolean {
	const ar = a.endsWith(path.sep) ? a : a + path.sep;
	const br = b.endsWith(path.sep) ? b : b + path.sep;
	return a === b || a.startsWith(br) || b.startsWith(ar);
}

function acquireLocks(sessionId: string, rawPaths: string[], cwd: string) {
	const paths = [
		...new Set(
			(rawPaths || []).map((p) => normalizeLockPath(p, cwd)).filter(Boolean),
		),
	].sort();
	const conflicts = [];
	for (const p of paths) {
		for (const [held, info] of locks.entries()) {
			if (info.sessionId !== sessionId && pathsConflict(p, held))
				conflicts.push({ path: p, heldPath: held, by: info.sessionId });
		}
	}
	if (conflicts.length) return { ok: false, conflicts };
	const acquiredAt = Date.now();
	for (const p of paths) locks.set(p, { sessionId, acquiredAt });
	return { ok: true, paths };
}

function releaseLocks(sessionId: string, rawPaths?: string[]) {
	const released = [];
	for (const [p, info] of locks.entries()) {
		if (
			info.sessionId === sessionId &&
			(!rawPaths || rawPaths.length === 0 || rawPaths.includes(p))
		) {
			locks.delete(p);
			released.push(p);
		}
	}
	return released;
}

function sendJson(socket: net.Socket, value: any): void {
	socket.write(JSON.stringify(value) + "\n");
}

function startBridgeServer(): void {
	if (bridgeServer) return;
	fs.mkdirSync(dataDir, { recursive: true });
	try {
		if (fs.existsSync(bridgeSocketPath)) fs.unlinkSync(bridgeSocketPath);
	} catch {}
	bridgeServer = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			while (true) {
				const i = buffer.indexOf("\n");
				if (i < 0) break;
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				if (!line.trim()) continue;
				try {
					const req = JSON.parse(line);
					const data = handleBridgeRequest(req);
					sendJson(socket, { id: req.id, success: true, data });
				} catch (error) {
					sendJson(socket, {
						success: false,
						error: String(error?.message || error),
					});
				}
			}
		});
	});
	bridgeServer.listen(bridgeSocketPath);
}

function handleBridgeRequest(req: any): any {
	switch (req.action) {
		case "switch": {
			const s = findSession(req.target || req.name);
			if (!s) throw new Error(`session not found: ${req.target || req.name}`);
			attachedSession = s.name;
			for (const session of sessions.values()) notifySession(session);
			return { ok: true };
		}
		case "detach":
			attachedSession = null;
			for (const session of sessions.values()) notifySession(session);
			return { ok: true };
		case "listSessions":
			return {
				sessions: [...sessions.values()]
					.filter((session) => session.state === "running")
					.map(publicSession),
			};
		case "createSession": {
			const session = createSession({
				name: req.name || `session-${Date.now().toString(36)}`,
				cwd: req.cwd || process.cwd(),
				resume: Boolean(req.resume),
			});
			attachedSession = session.name;
			for (const item of sessions.values()) notifySession(item);
			return { session };
		}
		case "killSession": {
			const session = stopSession(req.name);
			for (const item of sessions.values()) notifySession(item);
			return { session };
		}
		case "getCwd":
			return {
				cwd: state.parentCwd,
				parentTranscript: state.parentTranscript || "",
			};
		case "statusUpdate": {
			const target = findSession(req.sessionName || req.sessionId);
			if (target) {
				target.agentStatus = req.status || "idle";
				notifySession(target);
			}
			return { ok: true };
		}
		case "transcriptUpdate": {
			const target = findSession(req.sessionName || req.sessionId);
			if (target && req.transcript) {
				target.transcript = req.transcript;
				notifySession(target);
			}
			return { ok: true };
		}
		case "acquireLock":
			return acquireLocks(req.sessionId, req.paths || [], req.cwd);
		case "releaseLock":
			return { ok: true, released: releaseLocks(req.sessionId, req.paths) };
		default:
			throw new Error(`unknown bridge action: ${req.action}`);
	}
}

function bridgeCall(
	action: string,
	payload: Record<string, unknown> = {},
): Promise<any> {
	return new Promise((resolve, reject) => {
		const socketPath = process.env.PI_SESSIONS_BRIDGE_SOCKET;
		if (!socketPath)
			return reject(new Error("PI_SESSIONS_BRIDGE_SOCKET is not set"));
		const socket = net.createConnection(socketPath);
		const id = `child-${process.pid}-${Date.now().toString(36)}`;
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`bridge timeout: ${action}`));
		}, 5000);
		socket.on("connect", () =>
			socket.write(JSON.stringify({ id, action, ...payload }) + "\n"),
		);
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const i = buffer.indexOf("\n");
			if (i < 0) return;
			clearTimeout(timer);
			socket.end();
			const msg = JSON.parse(buffer.slice(0, i));
			if (msg.success === false) reject(new Error(msg.error || "bridge error"));
			else resolve(msg.data);
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function listSessions(): Promise<SessionInfo[]> {
	return [...sessions.values()]
		.filter((session) => session.state === "running")
		.map(publicSession);
}

async function selectorSessions(ctx: CommandContext): Promise<SessionInfo[]> {
	return [
		{
			id: PARENT_SESSION_ID,
			name: "parent",
			cwd: ctx.cwd || process.cwd(),
			state: "idle",
			status: "parent",
			pid: process.pid,
			lastActivityAt: 0,
			transcript: resolveTranscriptName(
				ctx.sessionManager?.getSessionName?.(),
				ctx.sessionManager?.getSessionFile?.(),
			),
		},
		...(await listSessions()),
	];
}

async function showList(ctx: CommandContext): Promise<void> {
	const items = await listSessions();
	if (!items.length) {
		ctx.ui.notify("No pi-sessions child processes.", "info");
		return;
	}
	ctx.ui.notify(
		["pi-sessions", ...items.map(formatSession)].join("\n"),
		"info",
	);
}

function disposePtyData(disposable: any): void {
	try {
		if (typeof disposable === "function") disposable();
		else disposable?.dispose?.();
	} catch {}
}

function resetTerminalModes(): void {
	process.stdout.write(
		[
			"\x1b[<u",
			"\x1b[?2004l",
			"\x1b[?1006l",
			"\x1b[?1004l",
			"\x1b[?1003l",
			"\x1b[?1002l",
			"\x1b[?1000l",
			"\x1b[?1049l",
			"\x1b[?1048l",
			"\x1b[?1047l",
			"\x1b[?47l",
			"\x1b[?25h",
			"\x1b>",
			"\x1b[?1l",
			"\x1b[0m",
		].join(""),
	);
}

async function attachSession(ctx: CommandContext, name: string): Promise<void> {
	const first = findSession(name);
	if (!first) throw new Error(`session not found: ${name}`);
	attachedSession = first.name;

	await ctx.ui.custom(
		(tui: any, _theme: any, _keybindings: any, done: () => void) => {
			let current: any = null;
			let ptyDataDisposable: any = null;
			let closed = false;
			const wasRaw = Boolean(process.stdin.isRaw);

			const resize = () => {
				const target = findSession(attachedSession);
				if (!target) return;
				resizeSession(
					target.name,
					process.stdout.columns || target.cols || 120,
					process.stdout.rows || target.rows || 40,
				);
			};

			const close = () => {
				if (closed) return;
				closed = true;
				disposePtyData(ptyDataDisposable);
				for (const session of sessions.values())
					session.subscribers.delete(refresh);
				process.stdin.off("data", onInput);
				process.stdout.off?.("resize", resize);
				if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
				process.stdout.write("\x1b[2J\x1b[H");
				tui.start();
				tui.requestRender(true);
				done();
			};

			const switchTo = (next: any) => {
				if (next === current) return;
				disposePtyData(ptyDataDisposable);
				current = next;
				attachedSession = next.name;
				resize();
				process.stdout.write("\x1b[0m\x1b[2J\x1b[H");
				if (next.replay) process.stdout.write(next.replay);
				ptyDataDisposable = next.pty.onData((data: string) =>
					process.stdout.write(data),
				);
			};

			function refresh() {
				if (closed) return;
				const next = findSession(attachedSession);
				if (!next || next.state !== "running") {
					attachedSession = null;
					close();
					return;
				}
				switchTo(next);
			}

			function onInput(chunk: Buffer | string) {
				const target = findSession(attachedSession);
				if (!target || target.state !== "running") return;
				target.pty.write(
					Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk,
				);
			}

			tui.stop();
			if (process.stdin.setRawMode) process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.on("data", onInput);
			process.stdout.on?.("resize", resize);
			for (const session of sessions.values()) session.subscribers.add(refresh);
			refresh();

			return { render: () => [], invalidate: () => {}, dispose: close };
		},
	);

	ctx.ui.notify("Detached from pi-sessions child.", "info");
}

async function openPanel(ctx: CommandContext): Promise<void> {
	await showSessionsPanel(ctx, {
		getSessions: () => selectorSessions(ctx),
		getAttached: () => attachedSession,
		getCwd: () => ctx.cwd || process.cwd(),
		switchTo: async (name: string) => {
			if (name === PARENT_SESSION_ID || name === "parent") {
				attachedSession = null;
				return;
			}
			attachedSession = name;
			setTimeout(() => void attachSession(ctx, name), 0);
		},
		newSession: async () => {
			const base = path.basename(ctx.cwd || process.cwd()) || "session";
			const session = createSession({
				name: `${base}-${Date.now().toString(36).slice(-5)}`,
				cwd: ctx.cwd,
			});
			attachedSession = session.name;
			setTimeout(() => void attachSession(ctx, session.name), 0);
		},
		newSessionInFolder: async (cwd: string) => {
			const base = path.basename(cwd) || "session";
			const session = createSession({
				name: `${base}-${Date.now().toString(36).slice(-5)}`,
				cwd,
			});
			attachedSession = session.name;
			setTimeout(() => void attachSession(ctx, session.name), 0);
		},
		resumeSession: async () => {
			const base = path.basename(ctx.cwd || process.cwd()) || "session";
			const session = createSession({
				name: `${base}-${Date.now().toString(36).slice(-5)}`,
				cwd: ctx.cwd,
				resume: true,
			});
			attachedSession = session.name;
			setTimeout(() => void attachSession(ctx, session.name), 0);
		},
		killSession: async (name: string) => {
			stopSession(name);
		},
		notify: (message: string, type?: "info" | "warning" | "error") =>
			ctx.ui.notify(message, type || "info"),
	});
}

async function openChildPanel(ctx: CommandContext): Promise<void> {
	await showSessionsPanel(ctx, {
		getSessions: async () => {
			const [data, cwdData] = await Promise.all([
				bridgeCall("listSessions"),
				bridgeCall("getCwd"),
			]);
			return [
				{
					id: PARENT_SESSION_ID,
					name: "parent",
					cwd: cwdData.cwd || "",
					state: "idle",
					status: "parent",
					pid: null,
					lastActivityAt: 0,
					transcript: cwdData.parentTranscript || "",
				},
				...(data.sessions || []),
			];
		},
		getAttached: () => process.env.PI_SESSIONS_SESSION_NAME || null,
		getCwd: () => ctx.cwd || process.cwd(),
		switchTo: async (name: string) => {
			if (name === PARENT_SESSION_ID || name === "parent") {
				await bridgeCall("detach", {
					from: process.env.PI_SESSIONS_SESSION_NAME,
				});
				return;
			}
			await bridgeCall("switch", {
				target: name,
				from: process.env.PI_SESSIONS_SESSION_NAME,
			});
		},
		newSession: async () => {
			const base = path.basename(ctx.cwd || process.cwd()) || "session";
			await bridgeCall("createSession", {
				name: `${base}-${Date.now().toString(36).slice(-5)}`,
				cwd: ctx.cwd,
				resume: false,
			});
		},
		newSessionInFolder: async (cwd: string) => {
			const base = path.basename(cwd) || "session";
			await bridgeCall("createSession", {
				name: `${base}-${Date.now().toString(36).slice(-5)}`,
				cwd,
				resume: false,
			});
		},
		resumeSession: async () => {
			const base = path.basename(ctx.cwd || process.cwd()) || "session";
			await bridgeCall("createSession", {
				name: `${base}-${Date.now().toString(36).slice(-5)}`,
				cwd: ctx.cwd,
				resume: true,
			});
		},
		killSession: async (name: string) => {
			await bridgeCall("killSession", { name });
		},
		notify: (message: string, type?: "info" | "warning" | "error") =>
			ctx.ui.notify(message, type || "info"),
	});
}

async function handleParentCommand(
	sub: string,
	args: string,
	ctx: CommandContext,
): Promise<void> {
	const rest = parseArgs(args || "");
	switch (sub) {
		case "new": {
			const name = rest[0] || `session-${Date.now().toString(36)}`;
			const session = createSession({ name, cwd: ctx.cwd });
			ctx.ui.notify(
				`Started pi session ${session.name} (pid ${session.pid ?? "?"})`,
				"info",
			);
			break;
		}
		case "resume": {
			const name = rest[0] || `session-${Date.now().toString(36)}`;
			const session = createSession({ name, cwd: ctx.cwd, resume: true });
			ctx.ui.notify(
				`Started resumable pi session ${session.name} (pid ${session.pid ?? "?"})`,
				"info",
			);
			await attachSession(ctx, session.name);
			break;
		}
		case "list":
			await showList(ctx);
			break;
		case "panel":
			await openPanel(ctx);
			break;
		case "attach":
		case "switch": {
			const name = rest[0] || attachedSession;
			if (!name) throw new Error(`Usage: /sessions:${sub} <name>`);
			await attachSession(ctx, name);
			break;
		}
		case "detach":
			attachedSession = null;
			ctx.ui.notify("No attached pi-sessions child in parent view.", "info");
			break;
		case "stop":
		case "kill": {
			const name = rest[0] || attachedSession;
			if (!name) throw new Error(`Usage: /sessions:${sub} <name>`);
			stopSession(name);
			ctx.ui.notify(`Killed ${name}`, "warning");
			break;
		}
		default:
			throw new Error(`Unknown pi-sessions command: ${sub}`);
	}
}

async function handleChildCommand(
	sub: string,
	args: string,
	ctx: CommandContext,
): Promise<void> {
	const rest = parseArgs(args || "");
	switch (sub) {
		case "switch": {
			const target = rest[0];
			if (!target) throw new Error("Usage: /sessions:switch <name>");
			await bridgeCall("switch", {
				target,
				from: process.env.PI_SESSIONS_SESSION_NAME,
			});
			ctx.ui.notify(`Requested parent switch to ${target}`, "info");
			break;
		}
		case "detach":
			await bridgeCall("detach", {
				from: process.env.PI_SESSIONS_SESSION_NAME,
			});
			ctx.ui.notify("Requested parent detach", "info");
			break;
		case "list": {
			const data = await bridgeCall("listSessions");
			ctx.ui.notify(
				["pi-sessions", ...(data.sessions || []).map(formatSession)].join("\n"),
				"info",
			);
			break;
		}
		default:
			throw new Error(
				`Child pi-sessions supports /sessions:switch, /sessions:detach, /sessions:list only (got ${sub})`,
			);
	}
}

function registerSessionsCommand(
	pi: ExtensionAPI,
	sub: string,
	description: string,
	childMode: boolean,
) {
	pi.registerCommand(`sessions:${sub}`, {
		description,
		handler: async (args: string, ctx: CommandContext) =>
			childMode
				? handleChildCommand(sub, args, ctx)
				: handleParentCommand(sub, args, ctx),
	});
}

export default function (pi: ExtensionAPI) {
	const childMode = process.env.PI_SESSIONS_CHILD === "1";

	if (childMode) {
		pi.registerCommand("sessions", {
			description: "Open the parent pi-sessions switcher",
			handler: async (_args: string, ctx: CommandContext) =>
				openChildPanel(ctx),
		});
		registerSessionsCommand(
			pi,
			"switch",
			"Ask parent pi-sessions to switch attached child",
			true,
		);
		registerSessionsCommand(
			pi,
			"detach",
			"Ask parent pi-sessions to detach this child",
			true,
		);
		registerSessionsCommand(
			pi,
			"list",
			"List parent pi-sessions children",
			true,
		);
		pi.on("session_start", (_event: any, ctx: CommandContext) => {
			const transcript = resolveTranscriptName(
				ctx.sessionManager?.getSessionName?.(),
				ctx.sessionManager?.getSessionFile?.(),
			);
			if (transcript) {
				bridgeCall("transcriptUpdate", {
					sessionName: process.env.PI_SESSIONS_SESSION_NAME,
					sessionId: process.env.PI_SESSIONS_SESSION_ID,
					transcript,
				}).catch(() => {});
			}
		});
		pi.on("agent_start", () => {
			bridgeCall("statusUpdate", {
				sessionName: process.env.PI_SESSIONS_SESSION_NAME,
				sessionId: process.env.PI_SESSIONS_SESSION_ID,
				status: "working",
			}).catch(() => {});
		});
		pi.on("agent_end", () => {
			bridgeCall("statusUpdate", {
				sessionName: process.env.PI_SESSIONS_SESSION_NAME,
				sessionId: process.env.PI_SESSIONS_SESSION_ID,
				status: "idle",
			}).catch(() => {});
		});
		return;
	}

	startBridgeServer();
	pi.on("session_start", (_event: any, ctx: CommandContext) => {
		state.parentCwd = ctx.cwd;
		state.parentTranscript = resolveTranscriptName(
			ctx.sessionManager?.getSessionName?.(),
			ctx.sessionManager?.getSessionFile?.(),
		);
	});
	pi.on("session_shutdown", () => {
		resetTerminalModes();
		for (const session of sessions.values()) session.pty?.kill("SIGTERM");
		sessions.clear();
		try {
			bridgeServer?.close();
			if (fs.existsSync(bridgeSocketPath)) fs.unlinkSync(bridgeSocketPath);
		} catch {}
	});

	pi.registerCommand("sessions", {
		description: "Open the pi-sessions switcher",
		handler: async (_args: string, ctx: CommandContext) => openPanel(ctx),
	});

	registerSessionsCommand(
		pi,
		"new",
		"Start a complete Pi TUI child process",
		false,
	);
	registerSessionsCommand(
		pi,
		"resume",
		"Start a child Pi with the built-in resume selector",
		false,
	);
	registerSessionsCommand(pi, "list", "List Pi TUI child processes", false);
	registerSessionsCommand(
		pi,
		"panel",
		"Open the pi-sessions control panel",
		false,
	);
	registerSessionsCommand(
		pi,
		"attach",
		"Attach to a Pi TUI child process",
		false,
	);
	registerSessionsCommand(
		pi,
		"switch",
		"Switch attached view to a Pi TUI child process",
		false,
	);
	registerSessionsCommand(
		pi,
		"detach",
		"Detach from a Pi TUI child process",
		false,
	);
	registerSessionsCommand(pi, "stop", "Kill a Pi TUI child process", false);
	registerSessionsCommand(pi, "kill", "Kill a Pi TUI child process", false);
}
