import {
	InteractiveMode,
	type ExtensionAPI,
	type ExtensionContext,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type CommandContext,
	handleComponents,
	handleReset,
	handleSeparator,
	showMenu,
} from "./command/index.ts";
import {
	isOpenAICodexModel,
	refreshCodexUsageLabel,
} from "./components/codex-usage.ts";
import { readGitStatus } from "./components/git.ts";
import { readRuntimeInfo } from "./components/runtime.ts";
import {
	onAgentEnd as tpsOnAgentEnd,
	onAgentStart as tpsOnAgentStart,
	onMessageEnd as tpsOnMessageEnd,
	onMessageStart as tpsOnMessageStart,
	onMessageUpdate as tpsOnMessageUpdate,
} from "./components/tps.ts";
import {
	isComponentEnabled,
	migrateLegacyPiStatusConfig,
	readPiStatusConfig,
} from "./config.ts";
import {
	GLOW_INTERVAL_MS,
	PROJECT_REFRESH_INTERVAL_MS,
	SHIMMER_CLASSIC_PADDING,
	SHIMMER_SPEED_CELLS_PER_S,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
} from "./constants.ts";
import { createPiStatusEditorFactory } from "./editor.ts";
import {
	createRuntimeHandles,
	createRuntimeState,
	syncInteractiveState,
} from "./state.ts";
import type { PiStatusConfig } from "./types.ts";

const WORKING_UI_PATCHED = Symbol.for("pi-status:interactive-mode-working-ui-patched");
const WORKING_UI_CONTEXT_PATCHED = Symbol.for("pi-status:context-working-ui-patched");
const WORKING_UI_HANDLER = Symbol.for("pi-status:working-ui-handler");
const ANSI_RE = /\x1b\[[0-9;]*m/g;

type WorkingUiHandler = {
	setWorkingMessage?: (message?: string) => void;
	setWorkingIndicator?: (options?: WorkingIndicatorOptions) => void;
};

export default function piStatus(pi: ExtensionAPI) {
	let config: PiStatusConfig = readPiStatusConfig();
	let lastCtx: ExtensionContext | undefined;
	let requestWidgetRender: (() => void) | undefined;
	let usageTimer: ReturnType<typeof setInterval> | undefined;
	let projectRefreshInFlight = false;
	let projectRefreshPending = false;

	const state = createRuntimeState();
	const handles = createRuntimeHandles();

	function requestRender() {
		requestWidgetRender?.();
	}

	function installWorkingUiPrototypePatch(): void {
		const g = globalThis as typeof globalThis & Record<symbol, unknown>;
		g[WORKING_UI_HANDLER] = {
			setWorkingMessage: (message?: string) => {
				state.workingMessage = message;
				requestRender();
			},
			setWorkingIndicator: (options?: WorkingIndicatorOptions) => {
				state.workingIndicatorFrames = options?.frames;
				state.workingIndicatorIntervalMs = options?.intervalMs;
				syncAnimation();
				requestRender();
			},
		} satisfies WorkingUiHandler;

		const proto = (InteractiveMode as unknown as { prototype?: Record<PropertyKey, unknown> })
			.prototype;
		if (!proto || proto[WORKING_UI_PATCHED]) return;

		const originalSetWorkingMessage = proto.setWorkingMessage;
		if (typeof originalSetWorkingMessage === "function") {
			proto.setWorkingMessage = function (message?: string) {
				const handler = g[WORKING_UI_HANDLER] as WorkingUiHandler | undefined;
				handler?.setWorkingMessage?.(message);
				return originalSetWorkingMessage.call(this, message);
			};
		}

		const originalSetWorkingIndicator = proto.setWorkingIndicator;
		if (typeof originalSetWorkingIndicator === "function") {
			proto.setWorkingIndicator = function (options?: WorkingIndicatorOptions) {
				const handler = g[WORKING_UI_HANDLER] as WorkingUiHandler | undefined;
				handler?.setWorkingIndicator?.(options);
				return originalSetWorkingIndicator.call(this, options);
			};
		}

		proto[WORKING_UI_PATCHED] = true;
	}

	function installWorkingUiContextPatch(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const ui = ctx.ui as typeof ctx.ui & Record<symbol, unknown>;
		if (ui[WORKING_UI_CONTEXT_PATCHED]) return;

		const g = globalThis as typeof globalThis & Record<symbol, unknown>;
		const originalSetWorkingMessage = ui.setWorkingMessage;
		if (typeof originalSetWorkingMessage === "function") {
			ui.setWorkingMessage = function (message?: string) {
				const handler = g[WORKING_UI_HANDLER] as WorkingUiHandler | undefined;
				handler?.setWorkingMessage?.(message);
				return originalSetWorkingMessage.call(this, message);
			};
		}

		const originalSetWorkingIndicator = ui.setWorkingIndicator;
		if (typeof originalSetWorkingIndicator === "function") {
			ui.setWorkingIndicator = function (options?: WorkingIndicatorOptions) {
				const handler = g[WORKING_UI_HANDLER] as WorkingUiHandler | undefined;
				handler?.setWorkingIndicator?.(options);
				return originalSetWorkingIndicator.call(this, options);
			};
		}

		ui[WORKING_UI_CONTEXT_PATCHED] = true;
	}

	async function refreshProjectState(ctx: ExtensionContext) {
		if (projectRefreshInFlight) {
			projectRefreshPending = true;
			return;
		}
		projectRefreshInFlight = true;
		try {
			const [gitStatus, runtime] = await Promise.all([
				readGitStatus(ctx.cwd),
				isComponentEnabled(config, "runtime")
					? readRuntimeInfo(ctx.cwd)
					: Promise.resolve(undefined),
			]);
			Object.assign(state, gitStatus);
			state.runtime = runtime;
		} finally {
			projectRefreshInFlight = false;
			requestRender();
			if (projectRefreshPending && !state.destroyed) {
				projectRefreshPending = false;
				void refreshProjectState(ctx);
			}
		}
	}

	/**
	 * Install the PiStatusEditor via setEditorComponent.
	 * This decorates the editor with zone-based border decorations
	 * following the Osdy-Pi border protocol.
	 */
	function installEditor(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => ({
			render: () => [],
			invalidate: () => {},
		}));
		ctx.ui.setEditorComponent(
			createPiStatusEditorFactory(
				config,
				state,
				ctx,
				ctx.ui.theme,
				(requestRender) => {
					requestWidgetRender = requestRender;
				},
			),
		);
	}

	function startProjectTimer(ctx: ExtensionContext) {
		if (handles.projectTimer) clearInterval(handles.projectTimer);
		handles.projectTimer = setInterval(
			() => void refreshProjectState(ctx),
			PROJECT_REFRESH_INTERVAL_MS,
		);
	}

	async function refreshUsageState(ctx: ExtensionContext, force = false) {
		if (
			!isComponentEnabled(config, "usage") ||
			!isOpenAICodexModel(ctx.model)
		) {
			state.codexUsageLabel = "";
			requestRender();
			return;
		}
		const label = await refreshCodexUsageLabel(ctx, { force });
		if (state.destroyed) return;
		state.codexUsageLabel = label;
		requestRender();
	}

	function startUsageTimer(ctx: ExtensionContext) {
		if (usageTimer) clearInterval(usageTimer);
		usageTimer = setInterval(() => void refreshUsageState(ctx), 60_000);
	}

	function clearSpinner(): void {
		if (handles.spinnerInterval) {
			clearInterval(handles.spinnerInterval);
			handles.spinnerInterval = undefined;
		}
		state.spinnerIndex = 0;
	}

	function clearGlow(): void {
		if (handles.glowInterval) {
			clearInterval(handles.glowInterval);
			handles.glowInterval = undefined;
		}
		state.glowPosition = 0;
		state.lastGlowAt = undefined;
	}

	function syncGlowAnimation(): void {
		clearGlow();
		if (state.activity === "idle" || !isComponentEnabled(config, "status")) return;
		state.lastGlowAt = Date.now();
		handles.glowInterval = setInterval(() => {
			if (state.destroyed || state.activity === "idle") {
				clearGlow();
				return;
			}
			const now = Date.now();
			const lastGlowAt = state.lastGlowAt ?? now;
			state.lastGlowAt = now;
			state.glowPosition +=
				((now - lastGlowAt) / 1000) * SHIMMER_SPEED_CELLS_PER_S;

			const label = (state.workingMessage ?? "Working...").replace(ANSI_RE, "");
			const period = Array.from(label).length + SHIMMER_CLASSIC_PADDING * 2;
			if (period > 0 && state.glowPosition >= period) {
				state.glowPosition %= period;
			}

			requestRender();
		}, GLOW_INTERVAL_MS);
	}

	function syncAnimation(): void {
		clearSpinner();
		syncGlowAnimation();
		const frames =
			state.activity === "idle"
				? SPINNER_FRAMES.idle
				: (state.workingIndicatorFrames ?? SPINNER_FRAMES.running);
		const animatesStatus = Boolean(frames && frames.length > 1);
		if (!animatesStatus) return;
		handles.spinnerInterval = setInterval(() => {
			if (state.destroyed) {
				clearSpinner();
				return;
			}
			state.spinnerIndex = (state.spinnerIndex + 1) % 1000;
			requestRender();
		}, state.workingIndicatorIntervalMs ?? SPINNER_INTERVAL_MS);
	}

	installWorkingUiPrototypePatch();

	const cmdCtx: CommandContext = {
		get config() {
			return config;
		},
		set config(v) {
			config = v;
		},
		state,
		requestRender,
		syncAnimation,
		installWidget: installEditor,
		refreshProjectState,
		get lastCtx() {
			return lastCtx;
		},
	};

	pi.on("session_start", async (_event, ctx) => {
		if (state.destroyed) return;
		migrateLegacyPiStatusConfig();
		config = readPiStatusConfig();
		installWorkingUiContextPatch(ctx);
		syncInteractiveState(state, ctx, pi);
		installEditor(ctx);
		syncAnimation();
		await Promise.all([refreshProjectState(ctx), refreshUsageState(ctx, true)]);
		startProjectTimer(ctx);
		startUsageTimer(ctx);
		requestRender();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (state.destroyed) return;
		installWorkingUiContextPatch(ctx);
		state.running = true;
		state.activity = "running";
		tpsOnAgentStart(state);
		syncAnimation();
		state.turnIndex = 1;
		syncInteractiveState(state, ctx, pi);
		requestRender();
		await refreshProjectState(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (state.destroyed) return;
		state.running = false;
		state.activity = "idle";
		tpsOnAgentEnd(state);
		syncInteractiveState(state, ctx, pi);
		syncAnimation();
		requestRender();
		void refreshUsageState(ctx, true);
	});

	pi.on("turn_start", async (event, ctx) => {
		if (state.destroyed) return;
		installWorkingUiContextPatch(ctx);
		state.activity = "running";
		state.turnIndex = event.turnIndex;
		syncAnimation();
		syncInteractiveState(state, ctx, pi);
		requestRender();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (state.destroyed) return;
		void refreshUsageState(ctx, true);
	});

	pi.on("message_start", async (event) => {
		tpsOnMessageStart(event);
	});

	pi.on("message_update", async (event) => {
		tpsOnMessageUpdate(event, state, requestRender);
	});

	pi.on("message_end", async (event, ctx) => {
		if (state.destroyed) return;
		tpsOnMessageEnd(event);
		syncInteractiveState(state, ctx, pi);
		requestRender();
		void refreshProjectState(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (state.destroyed) return;
		syncInteractiveState(state, ctx, pi);
		requestRender();
		void refreshUsageState(ctx, true);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (state.destroyed) return;
		syncInteractiveState(state, ctx, pi);
		requestRender();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		state.destroyed = true;
		clearSpinner();
		clearGlow();
		if (handles.projectTimer) clearInterval(handles.projectTimer);
		if (usageTimer) clearInterval(usageTimer);
		handles.projectTimer = undefined;
		usageTimer = undefined;
		requestRender();
	});

	pi.registerCommand("pi-status", {
		description:
			"Control the status bar around the Editor. Subcommands: components, separator, reset.",
		handler: async (args, ctx) => {
			const [sub] = args.trim().toLowerCase().split(/\s+/);
			if (sub === "components") return handleComponents(cmdCtx, ctx, pi);
			if (sub === "separator") return handleSeparator(cmdCtx, ctx);
			if (sub === "reset") return handleReset(cmdCtx, ctx);
			return showMenu(cmdCtx, ctx, pi);
		},
	});
}

export {
	getDefaultPiStatusConfig,
	readPiStatusConfig,
	writePiStatusConfig,
} from "./config.ts";
export {
	ALL_COMPONENT_IDS,
	COMPONENT_LABELS,
	DEFAULT_CONFIG,
	ZONE_IDS,
	ZONE_LABELS,
} from "./constants.ts";
export type {
	ComponentConfig,
	ComponentId,
	PiStatusConfig,
	Zone,
} from "./types.ts";
