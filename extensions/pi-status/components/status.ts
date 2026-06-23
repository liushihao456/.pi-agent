import {
	SHIMMER_CLASSIC_BAND_HALF_WIDTH,
	SHIMMER_CLASSIC_PADDING,
	SPINNER_FRAMES,
} from "../constants.ts";
import type { ComponentRenderInput } from "./type.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RESET_FG = "\x1b[39m";

// Match oh-my-pi classic shimmer shape: fixed-velocity cosine band.
type Rgb = { r: number; g: number; b: number };

const TIER_HIGH = 0.65;
const TIER_MID = 0.22;
const ANSI_16_RGB = new Map<number, Rgb>([
	[30, { r: 0, g: 0, b: 0 }],
	[31, { r: 205, g: 49, b: 49 }],
	[32, { r: 13, g: 188, b: 121 }],
	[33, { r: 229, g: 229, b: 16 }],
	[34, { r: 36, g: 114, b: 200 }],
	[35, { r: 188, g: 63, b: 188 }],
	[36, { r: 17, g: 168, b: 205 }],
	[37, { r: 229, g: 229, b: 229 }],
	[90, { r: 102, g: 102, b: 102 }],
	[91, { r: 241, g: 76, b: 76 }],
	[92, { r: 35, g: 209, b: 139 }],
	[93, { r: 245, g: 245, b: 67 }],
	[94, { r: 59, g: 142, b: 234 }],
	[95, { r: 214, g: 112, b: 214 }],
	[96, { r: 41, g: 184, b: 219 }],
	[97, { r: 255, g: 255, b: 255 }],
]);

type ShimmerColorCache = {
	dimAnsi: string;
	accentAnsi: string;
	low: Rgb | undefined;
	high: Rgb | undefined;
};

const shimmerColorCache = new WeakMap<object, ShimmerColorCache>();

function classicIntensity(position: number, index: number): number {
	const dist = Math.abs(index + SHIMMER_CLASSIC_PADDING - position);
	if (dist >= SHIMMER_CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_CLASSIC_BAND_HALF_WIDTH));
}

function ansi256ToRgb(code: number): Rgb | undefined {
	if (code >= 0 && code <= 15) return ANSI_16_RGB.get(code < 8 ? code + 30 : code + 82);
	if (code >= 16 && code <= 231) {
		const value = code - 16;
		const r = Math.floor(value / 36);
		const g = Math.floor((value % 36) / 6);
		const b = value % 6;
		const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		return { r: level(r), g: level(g), b: level(b) };
	}
	if (code >= 232 && code <= 255) {
		const level = 8 + (code - 232) * 10;
		return { r: level, g: level, b: level };
	}
	return undefined;
}

function parseFgAnsi(ansi: string): Rgb | undefined {
	const truecolor = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
	if (truecolor) {
		return {
			r: Number(truecolor[1]),
			g: Number(truecolor[2]),
			b: Number(truecolor[3]),
		};
	}
	const indexed = /38;5;(\d+)/.exec(ansi);
	if (indexed) return ansi256ToRgb(Number(indexed[1]));
	const basic = /\x1b\[([0-9;]+)m/.exec(ansi);
	if (!basic) return undefined;
	for (const part of basic[1].split(";")) {
		const rgb = ANSI_16_RGB.get(Number(part));
		if (rgb) return rgb;
	}
	return undefined;
}

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	return {
		r: Math.round(from.r + (to.r - from.r) * clamped),
		g: Math.round(from.g + (to.g - from.g) * clamped),
		b: Math.round(from.b + (to.b - from.b) * clamped),
	};
}

function smoothstep(t: number): number {
	const clamped = Math.max(0, Math.min(1, t));
	return clamped * clamped * (3 - 2 * clamped);
}

function truecolorFg(rgb: Rgb, text: string): string {
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}${RESET_FG}`;
}

function getShimmerColors(theme: ComponentRenderInput["theme"]): ShimmerColorCache {
	const dimAnsi = theme.getFgAnsi("dim");
	const accentAnsi = theme.getFgAnsi("accent");
	const cached = shimmerColorCache.get(theme as object);
	if (cached?.dimAnsi === dimAnsi && cached.accentAnsi === accentAnsi) {
		return cached;
	}

	const next = {
		dimAnsi,
		accentAnsi,
		low: parseFgAnsi(dimAnsi),
		high: parseFgAnsi(accentAnsi),
	};
	shimmerColorCache.set(theme as object, next);
	return next;
}

function renderGlowText(
	theme: ComponentRenderInput["theme"],
	text: string,
	position: number,
): string {
	const chars = Array.from(text.replace(ANSI_RE, ""));
	if (chars.length === 0) return "";

	const { low, high } = getShimmerColors(theme);

	return chars
		.map((char, index) => {
			const intensity = classicIntensity(position, index);

			if (low && high) {
				const color = mixRgb(low, high, smoothstep(intensity));
				const colored = truecolorFg(color, char);
				return intensity >= 0.88 ? theme.bold(colored) : colored;
			}

			// Fallback for themes whose ANSI color cannot be parsed.
			if (intensity >= TIER_HIGH) return theme.bold(theme.fg("accent", char));
			if (intensity >= TIER_MID) return theme.fg("muted", char);
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
	const glowingLabel = renderGlowText(theme, label, state.glowPosition);
	return icon
		? `${theme.fg("accent", icon)}\u202F${glowingLabel}`
		: glowingLabel;
}
