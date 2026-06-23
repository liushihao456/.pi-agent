import { SPINNER_FRAMES } from "../constants.ts";
import type { ComponentRenderInput } from "./type.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function renderGlowText(
	theme: ComponentRenderInput["theme"],
	text: string,
	phase: number,
): string {
	const chars = Array.from(text.replace(ANSI_RE, ""));
	if (chars.length === 0) return "";

	const padding = 6;
	const center = (phase % (chars.length + padding * 2)) - padding;

	return chars
		.map((char, index) => {
			const distance = Math.abs(index - center);

			if (distance < 0.5) return theme.bold(theme.fg("accent", char));
			if (distance < 1.5) return theme.fg("accent", char);
			if (distance < 2.5) return theme.fg("muted", char);
			return theme.fg("dim", char);
		})
		.join("");
}

export function renderStatusComponent({
	state,
	theme,
}: ComponentRenderInput): string {
	if (state.activity === "idle") return theme.fg("accent", "𝜋");

	const frames = state.workingIndicatorFrames ?? SPINNER_FRAMES.running;
	const icon =
		frames.length > 0 ? frames[state.spinnerIndex % frames.length] : "";
	const label = state.workingMessage ?? "Working...";
	const glowingLabel = renderGlowText(theme, label, state.glowIndex);
	return icon
		? `${theme.fg("accent", icon)}\u202F${glowingLabel}`
		: glowingLabel;
}
