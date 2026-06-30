import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface SettingsFile {
	toolBackground?: "default" | "transparent" | "outlines" | "border";
	mcpOutputMode?: "hidden" | "summary" | "preview";
	previewLines?: number;
	expandedPreviewMaxLines?: number;
	groupToolCalls?: boolean;
	bashCollapsedLines?: number;
	/** Show a small live output preview while tools are still running. Defaults to true. */
	liveToolPreview?: boolean;
	/** Number of live output lines to show while collapsed. Defaults to 5. */
	liveToolPreviewLines?: number;
	showTruncationHints?: boolean;
	diffCollapsedLines?: number;
	diffTheme?: string;
	diffColors?: Record<string, string>;
	/**
	 * When true (default), derive borders, dim text, branch rules, and diff
	 * accents from the active pi theme via `theme.getFgAnsi`/`getBgAnsi`.
	 * Explicit `diffTheme` / `diffColors` always win over theme-derived
	 * defaults so users keep full control.
	 */
	themeAdaptive?: boolean;
	/**
	 * Theme color key used for the spinner verb (e.g. "Cooking…"). Defaults
	 * to "accent". Useful when the active theme's accent is overloaded for
	 * borders, headings, or bash mode and the verb should pop differently.
	 * Valid keys are any of the pi theme `ThemeColor` names (e.g. accent,
	 * borderAccent, success, warning, mdHeading, thinkingMedium, bashMode).
	 */
	spinnerVerbColor?: string;
	/**
	 * Theme color key used for the spinner status suffix (the parenthesized
	 * "(thinking · ↓ 10 tokens · 2s)" trailer). Defaults to "muted".
	 */
	spinnerStatusColor?: string;
	/** Gray level 0–255 for ├─ └─ │ when branch color mode is `fixed`. */
	toolBranchRgbGray?: number;
	/** `fixed` (default): rgb gray 72, theme-independent. `theme`: dim → muted → borderMuted. */
	toolBranchColorMode?: "theme" | "fixed";
}

let settingsCache: { value: SettingsFile; timestamp: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 5_000;

export function readSettings(): SettingsFile {
	const now = Date.now();
	if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return settingsCache.value;
	}
	const cwdPath = `${process.cwd()}/.pi/settings.json`;
	const homePath = `${process.env.HOME ?? ""}/.pi/settings.json`;
	const merged: SettingsFile = {};
	for (const path of [cwdPath, homePath]) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8"));
			if (raw && typeof raw === "object") Object.assign(merged, raw as SettingsFile);
		} catch {
			// ignore invalid settings files
		}
	}
	settingsCache = { value: merged, timestamp: now };
	return merged;
}

export function invalidateSettingsCache(): void {
	settingsCache = null;
}

// Cross-extension bust signal for spinner.ts — it watches this counter on
// globalThis and invalidates its settings cache when it changes. Lets
// /cc-spinner edits take effect on the next 250ms spinner tick instead of
// waiting for the file-stat TTL.
const SPINNER_BUST_KEY = Symbol.for("pi-claude-style-tools:spinner-settings-bust");
export function bustSpinnerSettingsCache(): void {
	const current = ((globalThis as any)[SPINNER_BUST_KEY] as number | undefined) ?? 0;
	(globalThis as any)[SPINNER_BUST_KEY] = current + 1;
}

export function writeSettingsKey(key: string, value: unknown): void {
	invalidateSettingsCache(); // invalidate cache on write
	const home = process.env.HOME ?? "";
	if (!home) return;
	const dir = `${home}/.pi`;
	const path = `${dir}/settings.json`;
	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch { /* start fresh */ }
	if (value === undefined) {
		delete settings[key];
	} else {
		settings[key] = value;
	}
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
	} catch { /* best effort */ }
}
