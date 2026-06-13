import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

type EmacsState = {
	startedEmacsServer: boolean;
	serverStartPromise?: Promise<void>;
	lastEditedFile?: string;
};

const state: EmacsState = ((globalThis as any).__piEmacsExtensionState ??= {
	startedEmacsServer: false,
});

type SpawnOptions = {
	cwd?: string;
	stdio?: "inherit" | "ignore";
	timeoutMs?: number;
	onBefore?: () => void;
	onAfter?: () => void;
};

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

function emacsClient(args: string[], options: SpawnOptions = {}) {
	return run("emacsclient", args, options);
}

function withTerminalMouse(expression: string) {
	return `(progn (xterm-mouse-mode 1) (mouse-wheel-mode 1) ${expression})`;
}

function findFileExpression(path: string) {
	return withTerminalMouse(
		[
			`(let* ((file ${JSON.stringify(path)})`,
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
			`(let* ((dir ${JSON.stringify(cwd)})`,
			"(buf (dired-find-buffer-nocreate dir)))",
			"(if buf",
			"(progn",
			"(with-current-buffer buf",
			"(revert-buffer :ignore-auto :noconfirm))",
			"(switch-to-buffer buf))",
			"(dired dir)))",
		].join(" "),
	);
}

function emacsClientArgs(cwd: string) {
	return state.lastEditedFile
		? ["-nw", "-a", "", "-e", findFileExpression(state.lastEditedFile)]
		: ["-nw", "-a", "", "-e", diredExpression(cwd)];
}

function rememberEditedFile(input: unknown, cwd: string) {
	const path = (input as { path?: string }).path;
	if (!path) return;
	state.lastEditedFile = isAbsolute(path) ? path : resolve(cwd, path);
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

async function openEmacsClient(ctx: ExtensionContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify("emacsclient requires TUI mode", "error");
		return;
	}

	await ctx.ui.custom((tui, _theme, _keybindings, done) => {
		emacsClient(emacsClientArgs(ctx.cwd), {
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
				ctx.ui.notify(`Failed to start emacsclient: ${error.message}`, "error");
				done(null);
			});

		return { render: () => [], invalidate: () => {} };
	});
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

	pi.registerShortcut("ctrl+g", {
		description: "Open emacsclient",
		handler: openEmacsClient,
	});
}

export { ensureEmacsServer, openEmacsClient, stopEmacsServer };
