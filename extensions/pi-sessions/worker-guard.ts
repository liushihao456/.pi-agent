// @ts-nocheck
import net from "node:net";
import path from "node:path";

type ExtensionAPI = any;

const socketPath = process.env.PI_SESSIONS_BRIDGE_SOCKET;
const sessionId = process.env.PI_SESSIONS_SESSION_ID || "unknown";
const sessionName = process.env.PI_SESSIONS_SESSION_NAME || sessionId;
let seq = 0;
const heldByToolCall = new Map<string, string[]>();

function request(
	action: string,
	payload: Record<string, unknown> = {},
): Promise<any> {
	return new Promise((resolve, reject) => {
		if (!socketPath)
			return reject(new Error("PI_SESSIONS_BRIDGE_SOCKET is not set"));
		const socket = net.createConnection(socketPath);
		const id = `guard-${sessionId}-${++seq}`;
		let buffer = "";
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`pi-sessions guard timeout: ${action}`));
		}, 30000);
		socket.on("connect", () =>
			socket.write(
				JSON.stringify({
					id,
					action,
					sessionId,
					sessionName,
					workerId: sessionId,
					workerName: sessionName,
					...payload,
				}) + "\n",
			),
		);
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const i = buffer.indexOf("\n");
			if (i < 0) return;
			clearTimeout(timeout);
			const line = buffer.slice(0, i);
			socket.end();
			try {
				const msg = JSON.parse(line);
				if (msg.success === false)
					reject(new Error(msg.error || "bridge error"));
				else resolve(msg.data);
			} catch (err) {
				reject(err);
			}
		});
		socket.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function inferToolPaths(toolName: string, input: any): string[] {
	const paths = new Set<string>();
	if (toolName === "write" || toolName === "edit") {
		const p =
			asString(input?.path) ||
			asString(input?.file_path) ||
			asString(input?.filePath);
		if (p) paths.add(p);
	}
	if (toolName === "bash") {
		const command = asString(input?.command) || "";
		const redir = [...command.matchAll(/(?:>|>>|2>|&>)\s*([^\s;&|]+)/g)].map(
			(m) => m[1],
		);
		for (const p of redir)
			if (p && !p.startsWith("/dev/")) paths.add(p.replace(/^['"]|['"]$/g, ""));
		const mutating =
			/\b(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|install|tee|sed\s+-i|perl\s+-i|python\b.*\b(open|write)|node\b.*writeFile)\b/.test(
				command,
			);
		if (mutating) {
			const tokens = command.match(/(?:\.\.?|~|\/)?[\w@%+=:,./-]+/g) || [];
			for (const token of tokens) {
				if (token.includes("/") || token.startsWith("."))
					paths.add(token.replace(/^['"]|['"]$/g, ""));
			}
			if (paths.size === 0) paths.add(".");
		}
	}
	return [...paths];
}

function needsPermission(toolName: string, input: any): string | null {
	if (toolName === "bash") {
		const command = asString(input?.command) || "";
		if (/\bsudo\b|\brm\s+(-rf?|--recursive|--force)/i.test(command))
			return `Dangerous bash command in ${sessionName}: ${command}`;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event: any, ctx: any) => {
		const reason = needsPermission(event.toolName, event.input);
		if (reason) {
			const ok = await ctx.ui.confirm("pi-sessions permission", reason, {
				timeout: 60000,
			} as any);
			if (!ok)
				return {
					block: true,
					reason: "Denied by pi-sessions permission routing",
				};
		}

		const paths = inferToolPaths(event.toolName, event.input);
		if (paths.length === 0) return undefined;
		let result: any;
		try {
			result = await request("acquireLock", { paths, cwd: ctx.cwd });
		} catch (error) {
			return {
				block: true,
				reason: `pi-sessions lock bridge unavailable: ${String(error)}`,
			};
		}
		if (!result?.ok) {
			return {
				block: true,
				reason: `pi-sessions path lock conflict: ${JSON.stringify(result?.conflicts || [])}`,
			};
		}
		heldByToolCall.set(
			event.toolCallId,
			result.paths || paths.map((p) => path.resolve(ctx.cwd, p)),
		);
		return undefined;
	});

	pi.on("tool_result", async (event: any) => {
		const paths = heldByToolCall.get(event.toolCallId);
		if (!paths) return undefined;
		heldByToolCall.delete(event.toolCallId);
		try {
			await request("releaseLock", { paths });
		} catch (error) {
			void error;
			// Parent bridge also cleans stale locks when the child exits.
		}
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		try {
			await request("releaseLock", { paths: [] });
		} catch (error) {
			void error;
		}
	});
}
