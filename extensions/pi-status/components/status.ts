import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_THEME_COLORS, SPINNER_FRAMES } from "../constants.ts";
import type { ComponentRenderInput } from "./type.ts";

export function renderStatusComponent({
	state,
	theme,
}: ComponentRenderInput): string {
	if (state.activity === "idle") return theme.fg("accent", "𝜋");

	const frames =
		state.activity === "error"
			? SPINNER_FRAMES[state.activity]
			: (state.workingIndicatorFrames ?? SPINNER_FRAMES[state.activity]);
	const icon =
		frames.length > 0 ? frames[state.spinnerIndex % frames.length] : "";
	const elapsed =
		state.activity === "stale" && state.toolStartedAt
			? ` ${Math.floor((Date.now() - state.toolStartedAt) / 1000)}s`
			: "";
	const workingMessage = state.workingMessage ?? "Working...";
	const label =
		state.activity === "tool" || state.activity === "stale"
			? `${workingMessage}${elapsed}`
			: state.activity === "error"
				? "Error"
				: workingMessage;
	const text = icon ? `${icon}\u202F${label}` : label;
	return theme.fg(
		ACTIVITY_THEME_COLORS[state.activity] as ThemeColor,
		state.activity === "error" ? theme.bold(text) : text,
	);
}
