import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { rgPath } from "@vscode/ripgrep";
import { readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path, { isAbsolute, resolve } from "node:path";
import {
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

type Theme = {
	fg(color: string, text: string): string;
};

type EmacsState = {
	startedEmacsServer: boolean;
	serverStartPromise?: Promise<void>;
	lastEditedFile?: string;
};

type SpawnOptions = {
	cwd?: string;
	stdio?: "inherit" | "ignore" | "pipe";
	timeoutMs?: number;
	onBefore?: () => void;
	onAfter?: () => void;
};

type FileEntry = {
	name: string;
	path: string;
	isDirectory: boolean;
	mode: string;
	size: string;
	modified: Date;
};

const state: EmacsState = ((globalThis as any).__piEmacsExtensionState ??= {
	startedEmacsServer: false,
});

const FILE_EXPLORER_MAX_VISIBLE = 8;
const PROJECT_PICKER_MAX_VISIBLE = 12;

function run(command: string, args: string[], options: SpawnOptions = {}) {
	return new Promise<void>((resolve, reject) => {
		options.onBefore?.();

		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			stdio: options.stdio ?? "ignore",
		});

		const timer = options.timeoutMs
			? setTimeout(() => {
					child.kill("SIGTERM");
					finish(new Error(`${command} timed out`));
				}, options.timeoutMs)
			: undefined;

		let done = false;
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			options.onAfter?.();
			error ? reject(error) : resolve();
		};

		child.on("error", finish);
		child.on("close", (code, signal) => {
			code === 0
				? finish()
				: finish(new Error(`${command} exited with ${signal ?? code}`));
		});
	});
}

function execText(command: string, args: string[], options: SpawnOptions = {}) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve(Buffer.concat(stdout).toString("utf8"));
				return;
			}
			reject(
				new Error(
					Buffer.concat(stderr).toString("utf8").trim() ||
						`${command} exited with ${signal ?? code}`,
				),
			);
		});
	});
}

function emacsClient(args: string[], options: SpawnOptions = {}) {
	return run("emacsclient", args, options);
}

function withTerminalMouse(expression: string) {
	return `(progn (xterm-mouse-mode 1) (mouse-wheel-mode 1) ${expression})`;
}

function findFileExpression(filePath: string) {
	return withTerminalMouse(
		[
			`(let* ((file ${JSON.stringify(filePath)})`,
			"(buf (find-buffer-visiting file)))",
			"(if buf",
			"(progn",
			"(with-current-buffer buf",
			"(when (and (not (buffer-modified-p))",
			"(not (verify-visited-file-modtime buf)))",
			"(revert-buffer :ignore-auto :noconfirm)))",
			"(switch-to-buffer buf))",
			"(find-file file)))",
		].join(" "),
	);
}

function diredExpression(cwd: string) {
	return withTerminalMouse(
		[
          "(progn",
          "(mapc (lambda (b)",
          "(when (eq (buffer-local-value 'major-mode b) 'dired-mode)",
          "(kill-buffer b)))",
          "(buffer-list))",
          `(dired ${JSON.stringify(cwd)}))`,
		].join(" "),
	);
}

function expressionForPath(targetPath: string) {
	return statSync(targetPath).isDirectory()
		? diredExpression(targetPath)
		: findFileExpression(targetPath);
}

function emacsClientArgs(cwd: string) {
	return state.lastEditedFile
		? ["-nw", "-a", "", "-e", findFileExpression(state.lastEditedFile)]
		: ["-nw", "-a", "", "-e", diredExpression(cwd)];
}

function rememberEditedFile(input: unknown, cwd: string) {
	const filePath = (input as { path?: string }).path;
	if (!filePath) return;
	state.lastEditedFile = isAbsolute(filePath)
		? filePath
		: resolve(cwd, filePath);
}

function fits(width: number, text: string): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function indent(width: number, text: string): string {
	return fits(width, `  ${text}`);
}

function renderInputChild(input: Input, width: number): string {
	const line = input.render(Math.max(1, width))[0] ?? "";
	return line.startsWith("> ") ? line.slice(2) : line;
}

function setInputValueAtEnd(input: Input, value: string): void {
	input.setValue(value);
	(input as unknown as { cursor: number }).cursor = value.length;
}

function dirPrefix(value: string): string {
	const slash = value.lastIndexOf("/");
	return slash >= 0 ? value.slice(0, slash + 1) : "";
}

function formatSize(bytes: number): string {
	if (bytes < 1000) return `${bytes}`;
	if (bytes < 1_000_000)
		return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)}k`;
	if (bytes < 1_000_000_000)
		return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)}M`;
	return `${(bytes / 1_000_000_000).toFixed(1)}G`;
}

function modeString(mode: number, isDirectory: boolean): string {
	const type = isDirectory ? "d" : "-";
	const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
		.map((bit, index) => (mode & bit ? "rwx"[index % 3] : "-"))
		.join("");
	return `${type}${bits}`;
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

function normalizeExistingDir(input: string): string | null {
	try {
		const absolute = path.resolve(input.trim());
		if (!statSync(absolute).isDirectory()) return null;
		return absolute;
	} catch {
		return null;
	}
}

function readFileEntries(dir: string): FileEntry[] {
	const entries: FileEntry[] = [
		{
			name: "./",
			path: dir,
			isDirectory: true,
			mode: "drwxr-xr-x",
			size: "",
			modified: new Date(),
		},
	];

	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		try {
			const entryPath = path.join(dir, dirent.name);
			const stat = statSync(entryPath);
			const isDirectory = stat.isDirectory();
			entries.push({
				name: `${dirent.name}${isDirectory ? "/" : ""}`,
				path: entryPath,
				isDirectory,
				mode: modeString(stat.mode, isDirectory),
				size: formatSize(stat.size),
				modified: stat.mtime,
			});
		} catch {
			// Ignore unreadable entries.
		}
	}

	return entries.sort((a, b) => {
		if (a.name === "./") return -1;
		if (b.name === "./") return 1;
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

class FileExplorer implements Component, Focusable {
	private entries: FileEntry[] = [];
	private selectedIndex = 0;
	private readonly searchInput = new Input();
	private error: string | undefined;

	constructor(
		initialCwd: string,
		private readonly theme: Theme,
		private readonly done: (path: string | null) => void,
		private readonly requestRender: () => void,
	) {
		setInputValueAtEnd(
			this.searchInput,
			`${normalizeExistingDir(initialCwd) ?? homedir()}/`,
		);
		this.refresh();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.border(width));
		lines.push(this.header(width));
		lines.push(this.border(width, "dim"));
		this.renderEntries(lines, width);
		lines.push(this.border(width));
		lines.push(
			this.theme.fg(
				"dim",
				fits(
					width,
					"↑↓/<C-p>/<C-n> move · <tab> enter folder · <enter> open · <M-backspace> parent · <esc> cancel",
				),
			),
		);
		return lines;
	}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.enterSelectedDirectory();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.chooseSelectedPath();
			return;
		}
		if (getKeybindings().matches(data, "tui.editor.deleteWordBackward")) {
			this.deletePathSegmentBackward();
			return;
		}

		const before = this.search;
		const beforeDir = dirPrefix(before);
		this.searchInput.handleInput(data);
		const after = this.search;
		if (after !== before) {
			if (dirPrefix(after) !== beforeDir) this.refresh();
			else this.clampSelection();
		}
		this.requestRender();
	}

	private get search(): string {
		return this.searchInput.getValue();
	}

	private set search(value: string) {
		setInputValueAtEnd(this.searchInput, value);
	}

	private deletePathSegmentBackward(): void {
		const before = this.search;
		const trimmed = before.replace(/\/+$/, "");
		const slash = trimmed.lastIndexOf("/");
		if (slash < 0) return;
		const next = trimmed.slice(0, slash + 1);
		if (next === before) return;
		this.search = next || "/";
		this.refresh();
		this.requestRender();
	}

	private refresh(): void {
		try {
			this.entries = readFileEntries(dirPrefix(this.search));
			this.error = undefined;
			this.selectedIndex = Math.min(1, Math.max(0, this.entries.length - 1));
		} catch (error) {
			this.entries = [];
			this.selectedIndex = 0;
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private header(width: number): string {
		const entries = this.filteredEntries();
		const total = Math.max(1, entries.length);
		const index = Math.min(this.selectedIndex + 1, total);
		const prefix = `${index}/${total}\tFind file: `;
		const input = renderInputChild(
			this.searchInput,
			Math.max(1, width - visibleWidth(prefix)),
		);
		return this.theme.fg("accent", fits(width, `${prefix}${input}`));
	}

	private border(width: number, color: "accent" | "dim" = "accent"): string {
		return this.theme.fg(color, "─".repeat(Math.max(0, width)));
	}

	private renderEntries(lines: string[], width: number): void {
		if (this.error) {
			lines.push(this.theme.fg("dim", indent(width, this.error)));
			this.padRows(lines, width, 1);
			return;
		}
		const entries = this.filteredEntries();
		if (entries.length === 0) {
			lines.push(
				this.theme.fg(
					"dim",
					indent(width, this.search ? "No matches." : "No entries."),
				),
			);
			this.padRows(lines, width, 1);
			return;
		}

		let rendered = 0;
		const start = this.visibleStart(entries.length);
		const end = Math.min(entries.length, start + FILE_EXPLORER_MAX_VISIBLE);
		for (let i = start; i < end; i++) {
			lines.push(
				this.entryLine(width, entries[i]!, {
					selected: i === this.selectedIndex,
				}),
			);
			rendered++;
		}
		this.padRows(lines, width, rendered);
	}

	private entryLine(
		width: number,
		entry: FileEntry,
		options: { selected: boolean },
	): string {
		if (entry.name === "./") return this.currentDirLine(width, options);
		const left = `${options.selected ? "›" : " "} ${entry.name}`;
		const meta = `${entry.mode}  ${entry.size.padStart(5)}  ${relativeTime(entry.modified)}`;
		const metaWidth = Math.min(38, Math.max(0, Math.floor(width * 0.48)));
		const renderedMeta = fits(metaWidth, meta);
		const renderedLeft = fits(
			Math.max(0, width - visibleWidth(renderedMeta) - 1),
			left,
		);
		const gap = " ".repeat(
			Math.max(
				1,
				width - visibleWidth(renderedLeft) - visibleWidth(renderedMeta),
			),
		);
		const styledLeft = options.selected
			? this.theme.fg("accent", renderedLeft)
			: renderedLeft;
		return `${styledLeft}${gap}${this.theme.fg("dim", renderedMeta)}`;
	}

	private currentDirLine(
		width: number,
		options: { selected: boolean },
	): string {
		const marker = options.selected ? "›" : " ";
		const name = `${marker} ./`;
		const note = " (open current dir)";
		const availableNoteWidth = Math.max(0, width - visibleWidth(name));
		const renderedNote = fits(availableNoteWidth, note);
		const renderedName = fits(
			Math.max(0, width - visibleWidth(renderedNote)),
			name,
		);
		const padding = " ".repeat(
			Math.max(
				0,
				width - visibleWidth(renderedName) - visibleWidth(renderedNote),
			),
		);
		const styledName = options.selected
			? this.theme.fg("accent", renderedName)
			: renderedName;
		return `${styledName}${this.theme.fg("dim", renderedNote)}${padding}`;
	}

	private visibleStart(total: number): number {
		if (total <= FILE_EXPLORER_MAX_VISIBLE) return 0;
		const half = Math.floor(FILE_EXPLORER_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selectedIndex - half),
			total - FILE_EXPLORER_MAX_VISIBLE,
		);
	}

	private padRows(lines: string[], width: number, rendered: number): void {
		for (let i = rendered; i < FILE_EXPLORER_MAX_VISIBLE; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private filteredEntries(): FileEntry[] {
		const query = this.search.trim().split("/").pop() ?? "";
		if (!query) return this.entries;
		return fuzzyFilter(this.entries, query, (entry) => entry.name);
	}

	private clampSelection(): void {
		const maxIndex = Math.max(0, this.filteredEntries().length - 1);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, maxIndex));
	}

	private move(delta: number): void {
		const entries = this.filteredEntries();
		if (entries.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + entries.length) % entries.length;
		this.requestRender();
	}

	private selected(): FileEntry | undefined {
		return this.filteredEntries()[this.selectedIndex];
	}

	private enterSelectedDirectory(): void {
		const entry = this.selected();
		if (!entry?.isDirectory) return;
		const next = `${normalizeExistingDir(entry.path)}/`;
		if (!next) return;
		this.search = next;
		this.refresh();
		this.requestRender();
	}

	private chooseSelectedPath(): void {
		const entry = this.selected();
		if (entry) this.done(entry.path);
	}
}

class ProjectFilePicker implements Component, Focusable {
	private selectedIndex = 0;
	private readonly searchInput = new Input();

	constructor(
		private readonly cwd: string,
		private readonly files: string[],
		private readonly theme: Theme,
		private readonly done: (path: string | null) => void,
		private readonly requestRender: () => void,
	) {}

	render(width: number): string[] {
		const lines: string[] = [];
		const filtered = this.filteredFiles();
		lines.push(this.border(width));
		lines.push(this.header(width, filtered.length));
		lines.push(this.border(width, "dim"));
		this.renderFiles(lines, width, filtered);
		lines.push(this.border(width));
		lines.push(
			this.theme.fg(
				"dim",
				fits(width, "↑↓/<C-p>/<C-n> move · <enter> open · <esc> cancel"),
			),
		);
		return lines;
	}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.chooseSelectedFile();
			return;
		}

		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== before) this.clampSelection();
		this.requestRender();
	}

	private header(width: number, count: number): string {
		const total = Math.max(1, count);
		const index = Math.min(this.selectedIndex + 1, total);
		const prefix = `${index}/${total}\tProject file: `;
		const input = renderInputChild(
			this.searchInput,
			Math.max(1, width - visibleWidth(prefix)),
		);
		return this.theme.fg("accent", fits(width, `${prefix}${input}`));
	}

	private border(width: number, color: "accent" | "dim" = "accent"): string {
		return this.theme.fg(color, "─".repeat(Math.max(0, width)));
	}

	private renderFiles(lines: string[], width: number, files: string[]): void {
		if (files.length === 0) {
			lines.push(this.theme.fg("dim", indent(width, "No matches.")));
			this.padRows(lines, width, 1);
			return;
		}

		let rendered = 0;
		const start = this.visibleStart(files.length);
		const end = Math.min(files.length, start + PROJECT_PICKER_MAX_VISIBLE);
		for (let i = start; i < end; i++) {
			const marker = i === this.selectedIndex ? "›" : " ";
			const line = fits(width, `${marker} ${files[i]}`);
			lines.push(
				i === this.selectedIndex ? this.theme.fg("accent", line) : line,
			);
			rendered++;
		}
		this.padRows(lines, width, rendered);
	}

	private padRows(lines: string[], width: number, rendered: number): void {
		for (let i = rendered; i < PROJECT_PICKER_MAX_VISIBLE; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private filteredFiles(): string[] {
		const query = this.searchInput.getValue().trim();
		return query ? fuzzyFilter(this.files, query, (file) => file) : this.files;
	}

	private visibleStart(total: number): number {
		if (total <= PROJECT_PICKER_MAX_VISIBLE) return 0;
		const half = Math.floor(PROJECT_PICKER_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selectedIndex - half),
			total - PROJECT_PICKER_MAX_VISIBLE,
		);
	}

	private clampSelection(): void {
		const maxIndex = Math.max(0, this.filteredFiles().length - 1);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, maxIndex));
	}

	private move(delta: number): void {
		const files = this.filteredFiles();
		if (files.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + files.length) % files.length;
		this.requestRender();
	}

	private chooseSelectedFile(): void {
		const file = this.filteredFiles()[this.selectedIndex];
		if (file) this.done(path.join(this.cwd, file));
	}
}

async function projectFiles(cwd: string): Promise<string[]> {
	const output = await execText(
		rgPath,
		["--files", "--hidden", "--glob", "!.git/**"],
		{ cwd },
	);
	return output
		.split(/\r?\n/)
		.map((file) => file.trim())
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
}

async function choosePath(ctx: ExtensionContext): Promise<string | null> {
	if (!ctx.hasUI) return null;
	return (
		(await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			return new FileExplorer(ctx.cwd, theme as Theme, done, () =>
				tui.requestRender(),
			);
		})) ?? null
	);
}

async function chooseProjectFile(
	ctx: ExtensionContext,
): Promise<string | null> {
	if (!ctx.hasUI) return null;
	const files = await projectFiles(ctx.cwd);
	return (
		(await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			return new ProjectFilePicker(ctx.cwd, files, theme as Theme, done, () =>
				tui.requestRender(),
			);
		})) ?? null
	);
}

async function ensureEmacsServer() {
	state.serverStartPromise ??= (async () => {
		try {
			await emacsClient(["--eval", "(emacs-pid)"], { timeoutMs: 2000 });
			return;
		} catch {
			// No reachable server. Start daemon below.
		}

		console.log("[emacs] starting daemon...");
		await run("emacs", ["--daemon"], { timeoutMs: 15000 });
		state.startedEmacsServer = true;
		console.log("[emacs] daemon started");
	})();

	return state.serverStartPromise;
}

async function stopEmacsServer() {
	if (!state.startedEmacsServer) return;

	try {
		await state.serverStartPromise;
	} catch {
		return;
	}

	await emacsClient(["--eval", "(kill-emacs)"], { timeoutMs: 5000 });
	state.startedEmacsServer = false;
	state.serverStartPromise = undefined;
}

async function openEmacsWithArgs(
	ctx: ExtensionContext,
	args: string[],
	errorPrefix = "Failed to start emacsclient",
) {
	if (!ctx.hasUI) {
		ctx.ui.notify("emacsclient requires TUI mode", "error");
		return;
	}

	await ctx.ui.custom((tui, _theme, _keybindings, done) => {
		emacsClient(args, {
			cwd: ctx.cwd,
			stdio: "inherit",
			onBefore: () => {
				tui.stop();
				process.stdout.write("\x1B[2J\x1B[H");
				process.stdout.write("\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1006l");
			},
			onAfter: () => {
				tui.start();
				tui.requestRender(true);
			},
		})
			.then(() => done(null))
			.catch((error) => {
				ctx.ui.notify(`${errorPrefix}: ${error.message}`, "error");
				done(null);
			});

		return { render: () => [], invalidate: () => {} };
	});
}

async function openEmacsClient(ctx: ExtensionContext) {
	await openEmacsWithArgs(ctx, emacsClientArgs(ctx.cwd));
}

async function openEmacsPath(ctx: ExtensionContext, targetPath: string) {
	state.lastEditedFile = statSync(targetPath).isDirectory()
		? state.lastEditedFile
		: targetPath;
	await openEmacsWithArgs(ctx, [
		"-nw",
		"-a",
		"",
		"-e",
		expressionForPath(targetPath),
	]);
}

async function runFindFile(ctx: ExtensionContext) {
	const targetPath = await choosePath(ctx);
	if (targetPath) await openEmacsPath(ctx, targetPath);
}

async function runProjectFindFile(ctx: ExtensionContext) {
	try {
		const targetPath = await chooseProjectFile(ctx);
		if (targetPath) await openEmacsPath(ctx, targetPath);
	} catch (error) {
		ctx.ui.notify(
			`Failed to list project files: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		ensureEmacsServer().catch((error) => {
			console.error(`[emacs] failed to start server: ${error.message}`);
		});
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await stopEmacsServer();
	});

	pi.on("tool_result", (event, ctx) => {
		if (!event.isError && ["edit", "write"].includes(event.toolName)) {
			rememberEditedFile(event.input, ctx.cwd);
		}
	});

	pi.registerCommand("emacs", {
		description: "Open emacsclient in popup terminal",
		handler: async (_args, ctx) => openEmacsClient(ctx),
	});

	pi.registerCommand("emacs:find-file", {
		description: "Find and open a file or directory in Emacs",
		handler: async (_args, ctx) => runFindFile(ctx),
	});

	pi.registerCommand("emacs:project-find-file", {
		description: "Fuzzy-find a project file and open it in Emacs",
		handler: async (_args, ctx) => runProjectFindFile(ctx),
	});

	pi.registerShortcut("ctrl+g", {
		description: "Open emacsclient",
		handler: openEmacsClient,
	});
}

export { ensureEmacsServer, openEmacsClient, openEmacsPath, stopEmacsServer };
