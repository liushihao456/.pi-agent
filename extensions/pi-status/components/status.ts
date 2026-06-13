import { SPINNER_FRAMES } from "../constants.ts";
import type { ComponentRenderInput } from "./type.ts";

export function renderStatusComponent({
	state,
	theme,
}: ComponentRenderInput): string {
	if (state.activity === "idle") return theme.fg("accent", "𝜋");

	const frames = state.workingIndicatorFrames ?? SPINNER_FRAMES.running;
	const icon =
		frames.length > 0 ? frames[state.spinnerIndex % frames.length] : "";
	const label = state.workingMessage ?? "Working...";
	const text = icon ? `${icon}\u202F${label}` : label;
	return theme.fg("accent", text);
}
