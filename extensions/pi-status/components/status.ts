import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_THEME_COLORS, SPINNER_FRAMES } from "../constants.ts";
import type { ComponentRenderInput } from "./type.ts";

export function renderStatusComponent({
	state,
	theme,
}: ComponentRenderInput): string {
	if (state.activity === "idle") return theme.fg("accent", "𝜋");

	const frames = SPINNER_FRAMES[state.activity];
	const icon = frames[state.spinnerIndex % frames.length];
	const elapsed =
		state.activity === "stale" && state.toolStartedAt
			? ` ${Math.floor((Date.now() - state.toolStartedAt) / 1000)}s`
			: "";
	const label =
		state.activity === "tool" || state.activity === "stale"
			? `Running ${state.currentTool || "tool"}...${elapsed}`
			: state.activity === "error"
				? "Error"
				: "Working...";
	const text = `${icon}\u202F${label}`;
	return theme.fg(
		ACTIVITY_THEME_COLORS[state.activity] as ThemeColor,
		state.activity === "error" ? theme.bold(text) : text,
	);
}
