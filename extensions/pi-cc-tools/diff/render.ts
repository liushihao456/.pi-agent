import { basename, extname } from "node:path";

import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import type { BundledLanguage, BundledTheme } from "shiki";

import type { DiffColors, DiffLine, ParsedDiff } from "./types";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const TRANSPARENT_BG = "\x1b[49m";
const TRANSPARENT_RESET = `\x1b[0m${TRANSPARENT_BG}`;

const SPLIT_MIN_WIDTH = 150;
const SPLIT_MIN_CODE_WIDTH = 60;
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;
const SPLIT_MAX_CHANGED_ROWS = 180;
const MAX_TERM_WIDTH = 210;
const DEFAULT_TERM_WIDTH = 200;
export const MAX_PREVIEW_LINES = 60;
export const MAX_RENDER_LINES = 150;
const MAX_HL_CHARS = 32_000;
const CACHE_LIMIT = 48;
const WORD_DIFF_MIN_SIM = 0.15;
const WORD_DIFF_MAX_PAIR_CHARS = 1_000;
const WORD_DIFF_MAX_VISIBLE_ROWS = 120;
const WORD_DIFF_MAX_CHANGED_CHARS = 12_000;
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;

let D_RST = "\x1b[0m";
const D_BOLD = "\x1b[1m";
const D_DIM = "\x1b[2m";

let BG_ADD = "\x1b[49m";
let BG_DEL = "\x1b[49m";
let BG_ADD_W = "\x1b[49m";
let BG_DEL_W = "\x1b[49m";
let BG_GUTTER_ADD = "\x1b[49m";
let BG_GUTTER_DEL = "\x1b[49m";
let BG_EMPTY = "\x1b[49m";
let BG_BASE = "\x1b[49m";

let FG_ADD = "\x1b[38;2;100;180;120m";
let FG_DEL = "\x1b[38;2;200;100;100m";
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
let FG_STRIPE = "\x1b[38;2;40;40;40m";
let DIVIDER = `${FG_RULE}│${D_RST}`;
let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
export let DIFF_THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark";
let _diffOnLightBg = false;
let codeToAnsiLoader: Promise<any> | null = null;

export interface DiffRenderPaletteSnapshot {
	D_RST?: string;
	BG_ADD?: string;
	BG_DEL?: string;
	BG_ADD_W?: string;
	BG_DEL_W?: string;
	BG_GUTTER_ADD?: string;
	BG_GUTTER_DEL?: string;
	BG_EMPTY?: string;
	BG_BASE?: string;
	FG_ADD?: string;
	FG_DEL?: string;
	FG_DIM?: string;
	FG_LNUM?: string;
	FG_RULE?: string;
	FG_SAFE_MUTED?: string;
	FG_STRIPE?: string;
	DIVIDER?: string;
	DEFAULT_DIFF_COLORS?: DiffColors;
	DIFF_THEME?: BundledTheme;
	diffOnLightBg?: boolean;
}

export function setDiffRenderPalette(snapshot: DiffRenderPaletteSnapshot): void {
	if (snapshot.D_RST !== undefined) D_RST = snapshot.D_RST;
	if (snapshot.BG_ADD !== undefined) BG_ADD = snapshot.BG_ADD;
	if (snapshot.BG_DEL !== undefined) BG_DEL = snapshot.BG_DEL;
	if (snapshot.BG_ADD_W !== undefined) BG_ADD_W = snapshot.BG_ADD_W;
	if (snapshot.BG_DEL_W !== undefined) BG_DEL_W = snapshot.BG_DEL_W;
	if (snapshot.BG_GUTTER_ADD !== undefined) BG_GUTTER_ADD = snapshot.BG_GUTTER_ADD;
	if (snapshot.BG_GUTTER_DEL !== undefined) BG_GUTTER_DEL = snapshot.BG_GUTTER_DEL;
	if (snapshot.BG_EMPTY !== undefined) BG_EMPTY = snapshot.BG_EMPTY;
	if (snapshot.BG_BASE !== undefined) BG_BASE = snapshot.BG_BASE;
	if (snapshot.FG_ADD !== undefined) FG_ADD = snapshot.FG_ADD;
	if (snapshot.FG_DEL !== undefined) FG_DEL = snapshot.FG_DEL;
	if (snapshot.FG_DIM !== undefined) FG_DIM = snapshot.FG_DIM;
	if (snapshot.FG_LNUM !== undefined) FG_LNUM = snapshot.FG_LNUM;
	if (snapshot.FG_RULE !== undefined) FG_RULE = snapshot.FG_RULE;
	if (snapshot.FG_SAFE_MUTED !== undefined) FG_SAFE_MUTED = snapshot.FG_SAFE_MUTED;
	if (snapshot.FG_STRIPE !== undefined) FG_STRIPE = snapshot.FG_STRIPE;
	if (snapshot.DIFF_THEME !== undefined) DIFF_THEME = snapshot.DIFF_THEME;
	if (snapshot.diffOnLightBg !== undefined) _diffOnLightBg = snapshot.diffOnLightBg;
	DIVIDER = snapshot.DIVIDER ?? `${FG_RULE}│${D_RST}`;
	DEFAULT_DIFF_COLORS = snapshot.DEFAULT_DIFF_COLORS ?? { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
}

export function getDefaultDiffColors(): DiffColors {
	return DEFAULT_DIFF_COLORS;
}

export function diffStrip(value: string): string {
	return value.replace(ANSI_RE, "");
}

export function tabs(text: string): string {
	return text.replace(/\t/g, "  ");
}

export function termW(): number {
	const raw =
		process.stdout.columns ||
		(process.stderr as any).columns ||
		Number.parseInt(process.env.COLUMNS ?? "", 10) ||
		DEFAULT_TERM_WIDTH;
	return Math.max(40, Math.min(raw - 4, MAX_TERM_WIDTH));
}

export function branchDiffWidth(): number {
	return Math.max(40, termW() - 8);
}

export function adaptiveWrapRows(tw?: number): number {
	const width = tw ?? termW();
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

export function fit(value: string, width: number): string {
	if (width <= 0) return "";
	const plain = diffStrip(value);
	const plainVis = visibleWidth(plain);
	if (plainVis <= width) {
		const pad = width - plainVis;
		return pad > 0 ? value + " ".repeat(pad) : value;
	}
	const showWidth = width > 2 ? width - 1 : width;
	let vis = 0;
	let i = 0;
	while (i < value.length && vis < showWidth) {
		if (value[i] === "\x1b") {
			const end = value.indexOf("m", i);
			if (end !== -1) {
				i = end + 1;
				continue;
			}
		}
		vis += visibleWidth(value[i]);
		i++;
	}
	return width > 2 ? `${value.slice(0, i)}${D_RST}${FG_DIM}›${D_RST}` : `${value.slice(0, i)}${D_RST}`;
}

function ansiState(text: string): string {
	const matches = text.match(/\x1b\[[0-9;]*m/g) ?? [];
	let fg = "";
	let bg = "";
	for (const seq of matches) {
		const params = seq.slice(2, -1);
		if (params === "0") {
			fg = "";
			bg = "";
		} else if (params === "39") {
			fg = "";
		} else if (params.startsWith("38;")) {
			fg = seq;
		} else if (params.startsWith("48;")) {
			bg = seq;
		}
	}
	return bg + fg;
}

function normalizeShikiContrast(ansi: string): string {
	const darkFgThreshold = _diffOnLightBg ? 140 : 72;
	return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) => {
		if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return FG_SAFE_MUTED;
		if (!params.startsWith("38;2;")) return seq;
		const parts = params.split(";").map(Number);
		if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return seq;
		const [, , r, g, b] = parts;
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		if (_diffOnLightBg) {
			return luminance < darkFgThreshold ? seq : FG_SAFE_MUTED;
		}
		return luminance < darkFgThreshold ? FG_SAFE_MUTED : seq;
	});
}

export function wrapAnsi(text: string, width: number, maxRows = adaptiveWrapRows(), fillBg = ""): string[] {
	if (width <= 0) return [""];
	if (/^[\x20-\x7E]*$/.test(text) && text.length <= width) {
		const pad = width - text.length;
		return pad > 0 ? [text + fillBg + " ".repeat(pad) + (fillBg ? D_RST : "")] : [text];
	}
	const plain = diffStrip(text);
	const plainVis = visibleWidth(plain);
	if (plainVis <= width) {
		const pad = width - plainVis;
		return pad > 0 ? [text + fillBg + " ".repeat(pad) + (fillBg ? D_RST : "")] : [text];
	}

	const rows: string[] = [];
	let row = "";
	let vis = 0;
	let i = 0;
	let onLastRow = false;
	let effectiveWidth = width;

	while (i < text.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effectiveWidth = width > 2 ? width - 1 : width;
		}
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i);
			if (end !== -1) {
				row += text.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		if (vis >= effectiveWidth) {
			if (onLastRow) {
				let hasMore = false;
				for (let j = i; j < text.length; j++) {
					if (text[j] === "\x1b") {
						const e2 = text.indexOf("m", j);
						if (e2 !== -1) {
							j = e2;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && width > 2) row += `${D_RST}${FG_DIM}›${D_RST}`;
				else row += fillBg + " ".repeat(Math.max(0, width - vis)) + D_RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + D_RST);
			row = state + fillBg;
			vis = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effectiveWidth = width > 2 ? width - 1 : width;
			}
		}
		row += text[i];
		vis += visibleWidth(text[i]);
		i++;
	}

	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, width - vis)) + D_RST);
	}
	return rows;
}

function lnum(n: number | null, width: number, fg = FG_LNUM): string {
	if (n === null) return " ".repeat(width);
	const value = String(n);
	// Callers reset after the whole gutter cell so wrapped rows keep one
	// continuous add/remove background through the line-number/sign columns.
	return `${fg}${" ".repeat(Math.max(0, width - value.length))}${value}`;
}

function stripes(width: number): string {
	return BG_BASE + FG_STRIPE + "╱".repeat(width) + D_RST;
}

export function renderDiffStatBar(added: number, removed: number, width = termW()): string {
	const total = added + removed;
	if (total === 0 || width < 20) return "";
	const slots = Math.max(8, Math.min(20, Math.floor(width / 14)));
	let addSlots = Math.max(0, Math.min(slots, Math.round((added / total) * slots)));
	if (added > 0 && addSlots === 0) addSlots = 1;
	if (removed > 0 && addSlots >= slots) addSlots = slots - 1;
	const removeSlots = Math.max(0, slots - addSlots);
	const addBar = addSlots > 0 ? `${FG_ADD}${"━".repeat(addSlots)}${D_RST}` : "";
	const removeBar = removeSlots > 0 ? `${FG_DEL}${"━".repeat(removeSlots)}${D_RST}` : "";
	return `${FG_DIM}[${D_RST}${addBar}${removeBar}${FG_DIM}]${D_RST}`;
}

export function summarizeDiff(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) parts.push(`${FG_ADD}+${added}${D_RST}`);
	if (removed > 0) parts.push(`${FG_DEL}-${removed}${D_RST}`);
	if (!parts.length) return `${FG_DIM}no changes${D_RST}`;
	const bar = renderDiffStatBar(added, removed);
	return bar ? `${parts.join(" ")} ${bar}` : parts.join(" ");
}

export function diffSummaryWithMeta(added: number, removed: number, hunks: number, mode: string): string {
	const base = summarizeDiff(added, removed);
	const extras: string[] = [];
	if (hunks > 0) extras.push(`${FG_DIM}${hunks} hunk${hunks === 1 ? "" : "s"}${D_RST}`);
	if (mode) extras.push(`${FG_DIM}${mode}${D_RST}`);
	return extras.length ? `${base} ${FG_DIM}•${D_RST} ${extras.join(` ${FG_DIM}•${D_RST} `)}` : base;
}

function collapsedDiffHint(remainingLines: number, hiddenHunks: number, expanded = false): string {
	const width = termW();
	const action = expanded ? "collapse" : "expand";
	const candidates = [
		`… (${remainingLines} more diff lines${hiddenHunks > 0 ? ` • ${hiddenHunks} more hunks` : ""} • ${keyHint("app.tools.expand", `to ${action}`)})`,
		`… (${remainingLines} more lines${hiddenHunks > 0 ? ` • ${hiddenHunks} hunks` : ""})`,
		`… (+${remainingLines}${hiddenHunks > 0 ? ` • +${hiddenHunks}h` : ""})`,
		"…",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateToWidth("…", width, "");
}

function diffRule(width: number): string {
	return `${BG_BASE}${FG_RULE}${"─".repeat(width)}${D_RST}`;
}

export function shouldUseSplit(diff: ParsedDiff, tw: number, maxRows = MAX_PREVIEW_LINES): boolean {
	if (!diff.lines.length) return false;
	if (diff.added + diff.removed > SPLIT_MAX_CHANGED_ROWS) return false;
	if (tw < SPLIT_MIN_WIDTH) return false;
	const nw = Math.max(2, String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length);
	const half = Math.floor((tw - 1) / 2);
	const gw = nw + 4;
	const cw = Math.max(12, half - gw);
	if (cw < SPLIT_MIN_CODE_WIDTH) return false;
	const vis = diff.lines.slice(0, maxRows);
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const line of vis) {
		if (line.type === "sep") continue;
		contentLines++;
		if (tabs(line.content).length > cw) wrapCandidates++;
	}
	if (contentLines === 0) return true;
	const wrapRatio = wrapCandidates / contentLines;
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false;
	return true;
}

const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
};

export function lang(filePath: string): BundledLanguage | undefined {
	return EXT_LANG[extname(filePath).slice(1).toLowerCase()];
}

export async function codeToAnsiLazy(code: string, language: BundledLanguage, theme: BundledTheme): Promise<string> {
	if (!codeToAnsiLoader) {
		codeToAnsiLoader = import("@shikijs/cli").then((mod) => mod.codeToANSI);
	}
	const codeToAnsi = await codeToAnsiLoader;
	return codeToAnsi(code, language, theme);
}

export function detectLang(fp: string): BundledLanguage | undefined {
	const base = basename(fp).toLowerCase();
	if (base === "dockerfile") return "dockerfile";
	if (base === "makefile" || base === "gnumakefile") return "make";
	return EXT_LANG[extname(fp).slice(1).toLowerCase()];
}

const hlCache = new Map<string, string[]>();

export function clearHighlightCache(): void {
	hlCache.clear();
}

function touchCache(key: string, value: string[]): string[] {
	hlCache.delete(key);
	hlCache.set(key, value);
	while (hlCache.size > CACHE_LIMIT) {
		const first = hlCache.keys().next().value;
		if (first === undefined) break;
		hlCache.delete(first);
	}
	return value;
}

export async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");
	const key = `${DIFF_THEME}\0${language}\0${code}`;
	const hit = hlCache.get(key);
	if (hit) return touchCache(key, hit);
	try {
		const ansi = normalizeShikiContrast(await codeToAnsiLazy(code, language, DIFF_THEME));
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return touchCache(key, out);
	} catch {
		return code.split("\n");
	}
}

function parseDiff(oldContent: string, newContent: string, ctxLines = 3): ParsedDiff {
	const patch = Diff.structuredPatch("", "", oldContent, newContent, "", "", { context: ctxLines });
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (let hi = 0; hi < patch.hunks.length; hi++) {
		if (hi > 0) {
			const prev = patch.hunks[hi - 1];
			const gap = patch.hunks[hi].oldStart - (prev.oldStart + prev.oldLines);
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
		}
		const hunk = patch.hunks[hi];
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const raw of hunk.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const ch = raw[0];
			const text = raw.slice(1);
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: newLine++, content: text });
				added++;
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oldLine++, newNum: null, content: text });
				removed++;
			} else {
				lines.push({ type: "ctx", oldNum: oldLine++, newNum: newLine++, content: text });
			}
		}
	}
	return { lines, added, removed, chars: oldContent.length + newContent.length };
}

function getCachedParsedDiff(ctx: any, key: string, oldContent: string, newContent: string): ParsedDiff {
	if (ctx.state?._parsedDiffKey === key && ctx.state._parsedDiff) {
		return ctx.state._parsedDiff as ParsedDiff;
	}
	const diff = parseDiff(oldContent, newContent);
	if (ctx.state) {
		ctx.state._parsedDiffKey = key;
		ctx.state._parsedDiff = diff;
	}
	return diff;
}

function shouldUseWordDiff(oldText: string, newText: string): boolean {
	return oldText.length + newText.length <= WORD_DIFF_MAX_PAIR_CHARS;
}

function shouldUseAggregateWordDiff(lines: DiffLine[]): boolean {
	if (lines.length > WORD_DIFF_MAX_VISIBLE_ROWS) return false;
	let changedChars = 0;
	let changedRows = 0;
	for (const line of lines) {
		if (line.type !== "add" && line.type !== "del") continue;
		changedRows++;
		changedChars += line.content.length;
		if (changedChars > WORD_DIFF_MAX_CHANGED_CHARS) return false;
	}
	return changedRows <= WORD_DIFF_MAX_VISIBLE_ROWS;
}

export function wordDiffAnalysis(
	oldText: string,
	newText: string,
): { similarity: number; oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } {
	if (!oldText && !newText) return { similarity: 1, oldRanges: [], newRanges: [] };
	const parts = Diff.diffWords(oldText, newText);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oldPos = 0;
	let newPos = 0;
	let same = 0;
	for (const part of parts) {
		if (part.removed) {
			oldRanges.push([oldPos, oldPos + part.value.length]);
			oldPos += part.value.length;
		} else if (part.added) {
			newRanges.push([newPos, newPos + part.value.length]);
			newPos += part.value.length;
		} else {
			const len = part.value.length;
			same += len;
			oldPos += len;
			newPos += len;
		}
	}
	const maxLen = Math.max(oldText.length, newText.length);
	return { similarity: maxLen > 0 ? same / maxLen : 1, oldRanges, newRanges };
}

export function injectBg(ansiLine: string, ranges: Array<[number, number]>, baseBg: string, hlBg: string): string {
	if (!ranges.length) return baseBg + ansiLine + D_RST;
	let out = baseBg;
	let vis = 0;
	let inHL = false;
	let rangeIndex = 0;
	let i = 0;
	while (i < ansiLine.length) {
		if (ansiLine[i] === "\x1b") {
			const end = ansiLine.indexOf("m", i);
			if (end !== -1) {
				const seq = ansiLine.slice(i, end + 1);
				out += seq;
				if (seq === "\x1b[0m") out += inHL ? hlBg : baseBg;
				i = end + 1;
				continue;
			}
		}
		while (rangeIndex < ranges.length && vis >= ranges[rangeIndex][1]) rangeIndex++;
		const want = rangeIndex < ranges.length && vis >= ranges[rangeIndex][0] && vis < ranges[rangeIndex][1];
		if (want !== inHL) {
			inHL = want;
			out += inHL ? hlBg : baseBg;
		}
		out += ansiLine[i];
		vis++;
		i++;
	}
	return out + D_RST;
}

export function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
	const parts = Diff.diffWords(oldText, newText);
	let oldOut = "";
	let newOut = "";
	for (const part of parts) {
		if (part.removed) oldOut += `${BG_DEL_W}${part.value}${D_RST}${BG_DEL}`;
		else if (part.added) newOut += `${BG_ADD_W}${part.value}${D_RST}${BG_ADD}`;
		else {
			oldOut += part.value;
			newOut += part.value;
		}
	}
	return { old: oldOut, new: newOut };
}

export async function renderUnified(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_RENDER_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
	expanded = false,
): Promise<string> {
	if (!diff.lines.length) return "";
	const vis = diff.lines.slice(0, max);
	const tw = width;
	const nw = Math.max(2, String(Math.max(...vis.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length);
	const gw = nw + 4;
	const cw = Math.max(20, tw - gw);
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length <= MAX_RENDER_LINES;
	const canUseWordDiff = shouldUseAggregateWordDiff(vis);

	const oldSrc: string[] = [];
	const newSrc: string[] = [];
	for (const line of vis) {
		if (line.type === "ctx" || line.type === "del") oldSrc.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSrc.push(line.content);
	}
	const [oldHL, newHL] = canHL
		? await Promise.all([hlBlock(oldSrc.join("\n"), language), hlBlock(newSrc.join("\n"), language)])
		: [oldSrc, newSrc];

	let oldIndex = 0;
	let newIndex = 0;
	let index = 0;
	const out: string[] = [diffRule(tw)];

	function emitRow(num: number | null, sign: string, gutterBg: string, signFg: string, body: string, bodyBg = ""): void {
		const borderFg = sign === "-" ? dc.fgDel : sign === "+" ? dc.fgAdd : "";
		const numFg = borderFg || FG_LNUM;
		const gutter = `${BG_BASE}${lnum(num, nw, numFg)}${signFg}${sign} ${D_RST}${DIVIDER} `;
		const cont = `${BG_BASE}${" ".repeat(nw + 2)}${D_RST}${DIVIDER} `;
		const rows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(), bodyBg);
		out.push(`${gutter}${rows[0]}${D_RST}`);
		for (let r = 1; r < rows.length; r++) out.push(`${cont}${rows[r]}${D_RST}`);
	}

	while (index < vis.length) {
		const line = vis[index];
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap && gap > 0 ? ` ${gap} unmodified lines ` : "···";
			const totalW = Math.min(tw, 72);
			const pad = Math.max(0, totalW - label.length - 2);
			const half1 = Math.floor(pad / 2);
			const half2 = pad - half1;
			out.push(`${BG_BASE}${FG_DIM}${"─".repeat(half1)}${label}${"─".repeat(half2)}${D_RST}`);
			index++;
			continue;
		}
		if (line.type === "ctx") {
			const hl = oldHL[oldIndex] ?? line.content;
			emitRow(line.newNum, " ", BG_BASE, dc.fgCtx, `${BG_BASE}${D_DIM}${hl}`, BG_BASE);
			oldIndex++;
			newIndex++;
			index++;
			continue;
		}

		const dels: Array<{ l: DiffLine; hl: string }> = [];
		while (index < vis.length && vis[index].type === "del") {
			dels.push({ l: vis[index], hl: oldHL[oldIndex] ?? vis[index].content });
			oldIndex++;
			index++;
		}
		const adds: Array<{ l: DiffLine; hl: string }> = [];
		while (index < vis.length && vis[index].type === "add") {
			adds.push({ l: vis[index], hl: newHL[newIndex] ?? vis[index].content });
			newIndex++;
			index++;
		}

		const isPaired = dels.length === 1 && adds.length === 1;
		const canWordDiff = canUseWordDiff && isPaired && shouldUseWordDiff(dels[0].l.content, adds[0].l.content);
		const wd = canWordDiff ? wordDiffAnalysis(dels[0].l.content, adds[0].l.content) : null;
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, `${dc.fgDel}${D_BOLD}`, injectBg(dels[0].hl, wd.oldRanges, BG_DEL, BG_DEL_W), BG_DEL);
			emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, `${dc.fgAdd}${D_BOLD}`, injectBg(adds[0].hl, wd.newRanges, BG_ADD, BG_ADD_W), BG_ADD);
			continue;
		}
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(dels[0].l.content, adds[0].l.content);
			emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, `${dc.fgDel}${D_BOLD}`, `${BG_DEL}${pwd.old}`, BG_DEL);
			emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, `${dc.fgAdd}${D_BOLD}`, `${BG_ADD}${pwd.new}`, BG_ADD);
			continue;
		}
		for (const d of dels) emitRow(d.l.oldNum, "-", BG_GUTTER_DEL, `${dc.fgDel}${D_BOLD}`, `${BG_DEL}${canHL ? d.hl : d.l.content}`, BG_DEL);
		for (const a of adds) emitRow(a.l.newNum, "+", BG_GUTTER_ADD, `${dc.fgAdd}${D_BOLD}`, `${BG_ADD}${canHL ? a.hl : a.l.content}`, BG_ADD);
	}

	out.push(diffRule(tw));
	if (diff.lines.length > vis.length) out.push(`${BG_BASE}${FG_DIM}  ${collapsedDiffHint(diff.lines.length - vis.length, 0, expanded)}${D_RST}`);
	return out.join("\n");
}

export async function renderSplit(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_PREVIEW_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
	expanded = false,
): Promise<string> {
	const tw = width;
	if (!shouldUseSplit(diff, tw, max)) return renderUnified(diff, language, max, dc, width, expanded);
	if (!diff.lines.length) return "";

	type Row = { left: DiffLine | null; right: DiffLine | null };
	const rows: Row[] = [];
	let i = 0;
	while (i < diff.lines.length && rows.length < max) {
		const line = diff.lines[i];
		if (line.type === "sep" || line.type === "ctx") {
			rows.push({ left: line, right: line });
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (i < diff.lines.length && diff.lines[i].type === "del") dels.push(diff.lines[i++]);
		while (i < diff.lines.length && diff.lines[i].type === "add") adds.push(diff.lines[i++]);
		const n = Math.max(dels.length, adds.length);
		for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
	}

	const vis = rows.slice(0, max);
	const hiddenRows = Math.max(0, rows.length - vis.length) + (i < diff.lines.length ? Math.max(1, diff.lines.length - i) : 0);
	const half = Math.floor((tw - 1) / 2);
	const maxVisibleLineNo = Math.max(...vis.flatMap((row) => [row.left?.oldNum ?? row.left?.newNum ?? 0, row.right?.oldNum ?? row.right?.newNum ?? 0]), 0);
	const nw = Math.max(2, String(maxVisibleLineNo).length);
	const gw = nw + 4;
	const cw = Math.max(12, half - gw);
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length * 2 <= MAX_RENDER_LINES * 2;
	const canUseWordDiff = shouldUseAggregateWordDiff(vis.flatMap((row) => [row.left, row.right].filter((line): line is DiffLine => !!line)));

	const leftSrc: string[] = [];
	const rightSrc: string[] = [];
	for (const row of vis) {
		if (row.left && row.left.type !== "sep") leftSrc.push(row.left.content);
		if (row.right && row.right.type !== "sep") rightSrc.push(row.right.content);
	}
	const [leftHL, rightHL] = canHL
		? await Promise.all([hlBlock(leftSrc.join("\n"), language), hlBlock(rightSrc.join("\n"), language)])
		: [leftSrc, rightSrc];

	let leftIndex = 0;
	let rightIndex = 0;

	type HalfResult = { gutter: string; contGutter: string; bodyRows: string[] };
	function halfBuild(
		line: DiffLine | null,
		hl: string,
		ranges: Array<[number, number]> | null,
		side: "left" | "right",
	): HalfResult {
		if (!line) {
			const gPat = FG_STRIPE + "╱".repeat(nw + 2) + D_RST;
			const gutter = `${BG_BASE}${gPat}${FG_RULE}│${D_RST} `;
			return { gutter, contGutter: gutter, bodyRows: [stripes(cw)] };
		}
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap && gap > 0 ? `··· ${gap} lines ···` : "···";
			const gutter = `${BG_BASE}${FG_DIM}${fit("", nw + 2)}${D_RST}${FG_RULE}│${D_RST} `;
			return { gutter, contGutter: gutter, bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, cw)}${D_RST}`] };
		}
		const isDel = line.type === "del";
		const isAdd = line.type === "add";
		const cBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE;
		const sFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : dc.fgCtx;
		const sign = isDel ? "-" : isAdd ? "+" : " ";
		const num = isDel ? line.oldNum : isAdd ? line.newNum : side === "left" ? line.oldNum : line.newNum;
		const borderFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : "";
		const numFg = borderFg || FG_LNUM;
		let body: string;
		if (ranges && ranges.length > 0) body = injectBg(hl, ranges, cBg, isDel ? BG_DEL_W : BG_ADD_W);
		else if (isDel || isAdd) body = `${cBg}${hl}`;
		else body = `${BG_BASE}${D_DIM}${hl}`;
		const gutter = `${BG_BASE}${lnum(num, nw, numFg)}${sFg}${D_BOLD}${sign} ${D_RST}${FG_RULE}│${D_RST} `;
		const contGutter = `${BG_BASE}${" ".repeat(nw + 2)}${D_RST}${FG_RULE}│${D_RST} `;
		return { gutter, contGutter, bodyRows: wrapAnsi(tabs(body), cw, adaptiveWrapRows(), cBg) };
	}

	const out: string[] = [];
	const hdrOld = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgDel}${D_DIM}old${D_RST}`;
	const hdrNew = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgAdd}${D_DIM}new${D_RST}`;
	out.push(`${BG_BASE}${hdrOld}${" ".repeat(Math.max(0, half - nw - 1))}${FG_RULE}┊${D_RST}${hdrNew}`);
	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);

	for (const row of vis) {
		const leftLine = row.left;
		const rightLine = row.right;
		const paired = Boolean(leftLine && rightLine && leftLine.type === "del" && rightLine.type === "add");
		const canWordDiff = canUseWordDiff && paired && leftLine && rightLine && shouldUseWordDiff(leftLine.content, rightLine.content);
		const wd = canWordDiff && leftLine && rightLine ? wordDiffAnalysis(leftLine.content, rightLine.content) : null;
		let leftResult: HalfResult;
		let rightResult: HalfResult;
		if (paired && wd && leftLine && rightLine && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			leftResult = halfBuild(leftLine, leftHL[leftIndex++] ?? leftLine.content, wd.oldRanges, "left");
			rightResult = halfBuild(rightLine, rightHL[rightIndex++] ?? rightLine.content, wd.newRanges, "right");
		} else if (paired && wd && leftLine && rightLine && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(leftLine.content, rightLine.content);
			leftIndex++;
			rightIndex++;
			leftResult = halfBuild(leftLine, pwd.old, null, "left");
			rightResult = halfBuild(rightLine, pwd.new, null, "right");
		} else {
			leftResult = halfBuild(
				row.left,
				row.left && row.left.type !== "sep" ? (leftHL[leftIndex++] ?? row.left.content) : "",
				null,
				"left",
			);
			rightResult = halfBuild(
				row.right,
				row.right && row.right.type !== "sep" ? (rightHL[rightIndex++] ?? row.right.content) : "",
				null,
				"right",
			);
		}
		const maxRows = Math.max(leftResult.bodyRows.length, rightResult.bodyRows.length);
		for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
			const lg = rowIndex === 0 ? leftResult.gutter : leftResult.contGutter;
			const rg = rowIndex === 0 ? rightResult.gutter : rightResult.contGutter;
			const lb = leftResult.bodyRows[rowIndex] ?? (!row.left ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`);
			const rb = rightResult.bodyRows[rowIndex] ?? (!row.right ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`);
			out.push(`${lg}${lb}${DIVIDER}${rg}${rb}`);
		}
	}

	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);
	if (hiddenRows > 0) out.push(`${BG_BASE}${FG_DIM}  ${collapsedDiffHint(hiddenRows, 0, expanded)}${D_RST}`);
	return out.join("\n");

}
