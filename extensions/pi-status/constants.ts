import type {
	ActivityState,
	ComponentId,
	PiStatusConfig,
	Zone,
} from "./types.ts";

export const PROJECT_REFRESH_INTERVAL_MS = 30_000;
export const SPINNER_INTERVAL_MS = 80;
export const GLOW_INTERVAL_MS = 1000 / 30;
export const SHIMMER_SPEED_CELLS_PER_S = 20;
export const SHIMMER_CLASSIC_PADDING = 15;
export const SHIMMER_CLASSIC_BAND_HALF_WIDTH = 6;

export const ZONE_IDS: readonly Zone[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
] as const;

export const ZONE_LABELS: Record<Zone, string> = {
	"top-left": "Top Left",
	"top-right": "Top Right",
	"bottom-left": "Bottom Left",
	"bottom-right": "Bottom Right",
};

export const ALL_COMPONENT_IDS = [
	"status",
	"cwd",
	"git",
	"runtime",
	"cost",
	"model",
	"thinking",
	"context",
	"tokens",
	"turn",
	"tps",
	"usage",
] as const satisfies readonly ComponentId[];

export const COMPONENT_LABELS: Record<ComponentId, string> = {
	status: "Activity state / Pi logo",
	cwd: "Working directory",
	git: "Git branch and status",
	runtime: "Detected project runtime",
	cost: "Session cost",
	model: "Current model",
	thinking: "Thinking level",
	context: "Context usage",
	tokens: "Input/output token totals",
	turn: "Current turn number",
	tps: "Tokens per second",
	usage: "Codex 5h and weekly quota",
};

export const DEFAULT_CONFIG: PiStatusConfig = {
	separator: " · ",
	components: [
		{ id: "status", enabled: true, zone: "top-left" },
		{ id: "cwd", enabled: true, zone: "top-right" },
		{ id: "context", enabled: true, zone: "top-right" },
		{ id: "model", enabled: true, zone: "bottom-right" },
		{ id: "thinking", enabled: true, zone: "bottom-right" },
		{ id: "usage", enabled: true, zone: "bottom-right" },
		{ id: "turn", enabled: false, zone: "top-left" },
		{ id: "git", enabled: false, zone: "top-left" },
		{ id: "runtime", enabled: false, zone: "top-left" },
		{ id: "cost", enabled: false, zone: "top-right" },
		{ id: "tps", enabled: false, zone: "bottom-left" },
		{ id: "tokens", enabled: false, zone: "bottom-right" },
	],
};

export const STATUS_STYLES: Record<ComponentId | "separator", string> = {
	status: "accent",
	cwd: "bold cyan",
	git: "bold purple",
	runtime: "bold green",
	cost: "bold green",
	model: "bold blue",
	thinking: "bold yellow",
	context: "green",
	tokens: "bright-black",
	usage: "bold green",
	turn: "bright-black",
	tps: "bold green",
	separator: "bright-black",
};

export const SPINNER_FRAMES: Record<ActivityState, readonly string[]> = {
	idle: ["󰄯"],
	running: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
