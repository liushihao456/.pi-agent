// @ts-nocheck
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { clampLineWidth, stripAnsi } from "../render/ansi";

let deps: any = {
	WORKED_LINE_FG: "\x1b[38;2;140;140;140m",
	RESET: "\x1b[0m",
	toolBranchVisualEpoch: () => 0,
	sanitizeRenderedTextBlockLines: (lines: string[]) => lines,
	normalizeLeadingCheckGlyph: (line: string) => line,
	isCodeBoxChromeLine: () => false,
};

export function configureMarkdownRenderer(nextDeps: any): void {
	deps = { ...deps, ...(nextDeps ?? {}) };
}

export type MarkdownThemeLike = ConstructorParameters<typeof Markdown>[3];

type ParagraphSegment =
	| { kind: "markdown"; md: InstanceType<typeof Markdown> }
	| { kind: "math"; raw: string };

interface MathDelimiter {
	open: string;
	close: string;
}

const DISPLAY_MATH_DELIMITERS: MathDelimiter[] = [
	{ open: "\\[", close: "\\]" },
	{ open: "$$", close: "$$" },
	{ open: "\\begin{equation}", close: "\\end{equation}" },
	{ open: "\\begin{equation*}", close: "\\end{equation*}" },
	{ open: "\\begin{align}", close: "\\end{align}" },
	{ open: "\\begin{align*}", close: "\\end{align*}" },
	{ open: "\\begin{aligned}", close: "\\end{aligned}" },
];

const MATH_COMMANDS: Record<string, string> = {
	alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ", delta: "δ", Delta: "Δ",
	epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ",
	vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ",
	nu: "ν", xi: "ξ", Xi: "Ξ", pi: "π", Pi: "Π", rho: "ρ", varrho: "ϱ",
	sigma: "σ", Sigma: "Σ", tau: "τ", upsilon: "υ", Upsilon: "Υ", phi: "φ",
	varphi: "φ", Phi: "Φ", chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω",
	pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", ast: "*", le: "≤", leq: "≤",
	ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", propto: "∝",
	infty: "∞", partial: "∂", nabla: "∇", sum: "Σ", prod: "Π", int: "∫", sqrt: "√",
	to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", in: "∈", notin: "∉",
	cup: "∪", cap: "∩", subset: "⊂", subseteq: "⊆", superset: "⊃", superseteq: "⊇",
	wedge: "∧", vee: "∨", forall: "∀", exists: "∃", emptyset: "∅", degree: "°",
};

const COPY_SAFE_MARKDOWN_LINKS_FLAG = Symbol.for("pi-claude-style-tools:copy-safe-markdown-links");

/** Unordered list marker: monochrome ◉ (fisheye) instead of "- " (thinking blocks skip this). */
function assistantListBulletMarker(marker: string): string {
	if (marker.startsWith("- ")) return `◉ ${marker.slice(2)}`;
	return marker;
}

function copySafeMarkdownTheme(theme: MarkdownThemeLike): MarkdownThemeLike {
	const listBullet = theme.listBullet;
	return {
		...theme,
		link: (text: string) => stripAnsi(text),
		linkUrl: (text: string) => stripAnsi(text),
		listBullet: listBullet
			? (marker: string) => listBullet(assistantListBulletMarker(marker))
			: (marker: string) => assistantListBulletMarker(marker),
	};
}

export function makeMarkdownLinksCopySafe(markdown: InstanceType<typeof Markdown>): void {
	const markdownAny = markdown as any;
	if (markdownAny[COPY_SAFE_MARKDOWN_LINKS_FLAG] || !markdownAny.theme) return;
	markdownAny.theme = copySafeMarkdownTheme(markdownAny.theme);
	markdownAny[COPY_SAFE_MARKDOWN_LINKS_FLAG] = true;
	markdown.invalidate?.();
}

function codeSpan(text: string): string {
	const safe = text.replace(/`/g, "′");
	return `\`${safe}\``;
}

function looksLikeInlineMath(text: string): boolean {
	return /\\[A-Za-z]+|[_^=<>+*/-]/.test(text) && /[A-Za-z0-9}]/.test(text);
}

function hasInlineMathMarkers(text: string): boolean {
	return text.includes("\\(") || text.includes("$");
}

function replaceInlineMath(text: string): string {
	if (!hasInlineMathMarkers(text)) return text;
	const withParens = text.replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => {
		return codeSpan(formatMathForDisplay(body, false));
	});
	return withParens.replace(/(^|[^\\])\$([^\n$]{1,200})\$/g, (match, prefix: string, body: string) => {
		if (!looksLikeInlineMath(body)) return match;
		return `${prefix}${codeSpan(formatMathForDisplay(body, false))}`;
	});
}

interface MathBlock {
	index: number;
	contentStart: number;
	contentEnd: number;
	endIndex: number;
}

function findNextDelimitedMathBlock(text: string, start: number): MathBlock | undefined {
	let best: MathBlock | undefined;
	for (const delimiter of DISPLAY_MATH_DELIMITERS) {
		const index = text.indexOf(delimiter.open, start);
		if (index === -1) continue;
		const contentStart = index + delimiter.open.length;
		const contentEnd = text.indexOf(delimiter.close, contentStart);
		if (contentEnd === -1) continue;
		if (!best || index < best.index) {
			best = { index, contentStart, contentEnd, endIndex: contentEnd + delimiter.close.length };
		}
	}
	return best;
}

function looksLikeDisplayMath(text: string): boolean {
	return /\\[A-Za-z]+|[_^=<>+*/|]/.test(text) && /[A-Za-z0-9}]/.test(text);
}

function findNextLooseBracketMathBlock(text: string, start: number): MathBlock | undefined {
	const openRe = /(^|\r?\n)[ \t]*\[[ \t]*(?:\r?\n)/g;
	openRe.lastIndex = start;
	let openMatch: RegExpExecArray | null;
	while ((openMatch = openRe.exec(text))) {
		const index = openMatch.index + openMatch[1].length;
		const contentStart = openMatch.index + openMatch[0].length;
		const closeRe = /(^|\r?\n)[ \t]*\][ \t]*(?=\r?\n|$)/g;
		closeRe.lastIndex = contentStart;
		const closeMatch = closeRe.exec(text);
		if (!closeMatch) return undefined;
		const contentEnd = closeMatch.index + closeMatch[1].length;
		const raw = text.slice(contentStart, contentEnd).trim();
		if (looksLikeDisplayMath(raw)) {
			return { index, contentStart, contentEnd, endIndex: closeMatch.index + closeMatch[0].length };
		}
		openRe.lastIndex = contentStart;
	}
	return undefined;
}

function hasDisplayMathMarkers(text: string): boolean {
	return text.includes("\\[") || text.includes("$$") || text.includes("\\begin{") || /(^|\n)[ \t]*\[[ \t]*(?:\r?\n)/.test(text);
}

function shouldScanLooseBracketMath(text: string): boolean {
	return text.length < 20_000 && /(^|\n)[ \t]*\[[ \t]*(?:\r?\n)/.test(text);
}

function findNextDisplayMathBlock(text: string, start: number, scanLoose: boolean): MathBlock | undefined {
	const delimited = findNextDelimitedMathBlock(text, start);
	const loose = scanLoose ? findNextLooseBracketMathBlock(text, start) : undefined;
	if (!delimited) return loose;
	if (!loose) return delimited;
	return loose.index < delimited.index ? loose : delimited;
}

function looksLikeMarkdownDocument(text: string): boolean {
	if (/\r?\n\s*\r?\n/.test(text)) return true;
	if (/^#{1,6}\s/m.test(text) || /```/.test(text)) return true;
	if (/^\s*[-*+]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)) return true;
	if (/\|[^|\n]+\|/.test(text)) return true;
	if (/https?:\/\//.test(text)) return true;
	return false;
}

function shouldFormatStandaloneMath(text: string): boolean {
	const plain = text.trim();
	if (!plain || !plain.includes("\\")) return false;
	// Whole assistant paragraphs must stay markdown; misclassifying them collapses newlines.
	if (looksLikeMarkdownDocument(text)) return false;
	if (plain.length > 600 || plain.split(/\r?\n/).length > 3) return false;
	if (/\\(?:frac|dfrac|tfrac|sqrt|left|right|begin|end|partial|boldsymbol|bm|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|sigma|epsilon|delta|gamma|Gamma|Delta|theta|Theta|pi|Pi|rho|varrho|tau|phi|varphi|Psi|psi|omega|Omega|alpha|beta|mu|nu|xi|chi|sum|prod|int|to|rightarrow|leftarrow|leftrightarrow|infty)/.test(plain)) {
		return true;
	}
	// Paths like \opencode and prose with "=" are not math; require tight expression shape.
	if (!/[_^]/.test(plain) || !/\\[A-Za-z]+/.test(plain)) return false;
	return !/[.!?]\s/.test(plain) && plain.length <= 240;
}

function appendMarkdownSegment(segments: ParagraphSegment[], text: string, theme: MarkdownThemeLike): void {
	if (!text.trim()) return;
	const normalized = shouldFormatStandaloneMath(text) ? formatMathForDisplay(text, false) : replaceInlineMath(text);
	segments.push({ kind: "markdown", md: new Markdown(normalized, 0, 0, theme) });
}

function buildParagraphSegments(text: string, theme: MarkdownThemeLike): ParagraphSegment[] {
	const segments: ParagraphSegment[] = [];
	if (!hasDisplayMathMarkers(text)) {
		appendMarkdownSegment(segments, text, theme);
		return segments;
	}
	const scanLoose = shouldScanLooseBracketMath(text);
	let cursor = 0;
	while (cursor < text.length) {
		const next = findNextDisplayMathBlock(text, cursor, scanLoose);
		if (!next) break;
		appendMarkdownSegment(segments, text.slice(cursor, next.index), theme);
		const raw = text.slice(next.contentStart, next.contentEnd).trim();
		if (raw) segments.push({ kind: "math", raw });
		cursor = next.endIndex;
	}
	appendMarkdownSegment(segments, text.slice(cursor), theme);
	return segments;
}

function replaceSimpleCommandGroups(text: string): string {
	return text
		.replace(/\\(?:text|mathrm|operatorname|mathbf|boldsymbol|bm|mathit|mathsf|mathtt)\{([^{}]*)\}/g, "$1")
		.replace(/\\(?:boldsymbol|bm)\s+([A-Za-z])/g, "$1")
		.replace(/\\mathbb\{R\}/g, "ℝ")
		.replace(/\\mathbb\{N\}/g, "ℕ")
		.replace(/\\mathbb\{Z\}/g, "ℤ")
		.replace(/\\mathbb\{Q\}/g, "ℚ")
		.replace(/\\mathbb\{C\}/g, "ℂ");
}

function readLatexGroup(text: string, start: number): { content: string; end: number } | undefined {
	let open = start;
	while (open < text.length && /\s/.test(text[open])) open++;
	if (text[open] !== "{") return undefined;
	let depth = 1;
	for (let index = open + 1; index < text.length; index++) {
		const char = text[index];
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return { content: text.slice(open + 1, index), end: index + 1 };
		}
	}
	return undefined;
}

function replaceFractions(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const command = ["\\frac", "\\dfrac", "\\tfrac"].find((candidate) => text.startsWith(candidate, index));
		if (!command) {
			output += text[index];
			index++;
			continue;
		}
		const numerator = readLatexGroup(text, index + command.length);
		const denominator = numerator ? readLatexGroup(text, numerator.end) : undefined;
		if (!numerator || !denominator) {
			output += text[index];
			index++;
			continue;
		}
		output += `(${replaceFractions(numerator.content)})/(${replaceFractions(denominator.content)})`;
		index = denominator.end;
	}
	return output;
}

function replaceMathCommands(text: string): string {
	return text.replace(/\\([A-Za-z]+)/g, (match, name: string) => MATH_COMMANDS[name] ?? match);
}

function formatMathForDisplay(raw: string, multiline = true): string {
	let text = raw.replace(/\\\\/g, "\n");
	text = text.replace(/\\(?:begin|end)\{[^{}]+\}/g, "").replace(/&/g, "");
	text = replaceSimpleCommandGroups(text);
	text = replaceFractions(text);
	text = text.replace(/\\sqrt\s*\{([^{}]+)\}/g, "√($1)");
	text = replaceMathCommands(text);
	text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg)/g, "");
	text = text.replace(/_\{([^{}]+)\}/g, "_$1").replace(/\^\{([^{}]+)\}/g, "^$1");
	text = text.replace(/[{}]/g, "").replace(/\\[,;!]/g, " ").replace(/\\ /g, " ");
	text = text.replace(/[ \t]+/g, " ").replace(/\s*([=+\-×·÷<>≤≥≈≠|])\s*/g, " $1 ");
	const lines = text.split(/\r?\n/).map((line) => line.replace(/[ \t]{2,}/g, " ").trim()).filter(Boolean);
	return multiline ? lines.join("\n") : lines.join(" ");
}

function renderMathBlock(raw: string, width: number, theme: MarkdownThemeLike): string[] {
	const safeWidth = Math.max(12, width);
	const formatted = formatMathForDisplay(raw, true) || raw;
	return formatted
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(theme.bold(line), safeWidth));
}

export class DottedParagraph {
	private segments: ParagraphSegment[];
	private markdownTheme: MarkdownThemeLike;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, markdownTheme: MarkdownThemeLike) {
		this.markdownTheme = copySafeMarkdownTheme(markdownTheme);
		this.segments = buildParagraphSegments(text, this.markdownTheme);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		for (const segment of this.segments) {
			if (segment.kind === "markdown") segment.md.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) {
			this.cachedWidth = width;
			this.cachedLines = [""];
			return this.cachedLines;
		}
		// " ● " = 1 margin + dot + space = 3 visible chars
		const PREFIX_W = 3;
		if (safeWidth <= PREFIX_W) {
			this.cachedWidth = width;
			this.cachedLines = [clampLineWidth(" ● ", safeWidth)];
			return this.cachedLines;
		}
		const contentWidth = safeWidth - PREFIX_W;
		const lines = this.segments.flatMap((segment) => {
			return segment.kind === "math"
				? renderMathBlock(segment.raw, contentWidth, this.markdownTheme)
				: deps.sanitizeRenderedTextBlockLines(segment.md.render(contentWidth), contentWidth);
		});
		const looksLikeTaskStatus = lines.some((line) => /\b(?:transcript:|No output\.|Wrapped up)/.test(stripAnsi(line)));
		const displayLines = looksLikeTaskStatus ? lines.map(deps.normalizeLeadingCheckGlyph) : lines;
		let dotPlaced = false;
		const rendered = displayLines.map((line: string) => {
			if (!stripAnsi(line).trim()) return `   ${line}`;
			if (deps.isCodeBoxChromeLine(line)) return `   ${line}`;
			if (!dotPlaced) {
				dotPlaced = true;
				return ` ● ${line}`;
			}
			return `   ${line}`;
		}).map((line) => {
			const gap = safeWidth - visibleWidth(line);
			return gap > 0 ? line + " ".repeat(gap) : gap < 0 ? truncateToWidth(line, safeWidth, "", false) : line;
		});
		this.cachedWidth = width;
		this.cachedLines = rendered;
		return rendered;
	}
}

function replaceHiddenThinkingPlaceholders(container: { children?: any[] }, message: any): void {
	if (!container?.children) return;
	const summary = hiddenThinkingSummaryForMessage(message);
	for (let i = 0; i < container.children.length; i++) {
		const child = container.children[i];
		if (child instanceof HiddenThinkingSummary) {
			child.setSummary(summary);
			continue;
		}
		if (isHiddenThinkingPlaceholderText(child)) {
			container.children[i] = new HiddenThinkingSummary(summary);
		}
	}
}

export class ThinkingParagraph {
	private text: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private chromeEpoch = -1;

	constructor(
		text: string,
		_markdownTheme: ConstructorParameters<typeof Markdown>[3],
		_defaultTextStyle?: ConstructorParameters<typeof Markdown>[4],
	) {
		this.text = text;
	}

	private thinkingMarkdown(): InstanceType<typeof Markdown> {
		const DIM_FG = deps.WORKED_LINE_FG;
		const ITALIC = "\x1b[3m";
		const wrap = (s: string) => `${DIM_FG}${ITALIC}${s}`;
		const wrapPlain = (s: string) => wrap(stripAnsi(s));
		const plainTheme: ConstructorParameters<typeof Markdown>[3] = {
			heading: wrap,
			link: wrapPlain,
			linkUrl: wrapPlain,
			code: wrap,
			codeBlock: wrap,
			codeBlockBorder: wrap,
			quote: wrap,
			quoteBorder: wrap,
			hr: wrap,
			listBullet: (marker: string) => wrap(marker),
			bold: wrap,
			italic: wrap,
			strikethrough: wrap,
			underline: wrap,
			highlightCode: (code: string, _lang?: string) => code.split("\n").map((line) => `${DIM_FG}${ITALIC}${line}`),
		};
		const plainStyle: ConstructorParameters<typeof Markdown>[4] = {
			italic: true,
			color: (s: string) => `${DIM_FG}${ITALIC}${s}`,
		};
		return new Markdown(this.text, 0, 0, plainTheme, plainStyle);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.chromeEpoch = -1;
	}

	render(width: number): string[] {
		if (
			this.cachedLines
			&& this.cachedWidth === width
			&& this.chromeEpoch === deps.toolBranchVisualEpoch()
		) {
			return this.cachedLines;
		}
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) {
			this.cachedWidth = width;
			this.cachedLines = [""];
			this.chromeEpoch = deps.toolBranchVisualEpoch();
			return this.cachedLines;
		}
		const md = this.thinkingMarkdown();
		// " ✻ " = 1 margin + symbol + space = 3 visible chars
		const PREFIX_W = 3;
		const prefix = `${deps.WORKED_LINE_FG}✻${deps.RESET}`;
		if (safeWidth <= PREFIX_W) {
			this.cachedWidth = width;
			this.cachedLines = [clampLineWidth(` ${prefix} `, safeWidth)];
			return this.cachedLines;
		}
		const lines = deps.sanitizeRenderedTextBlockLines(md.render(safeWidth - PREFIX_W), safeWidth - PREFIX_W);
		let symbolPlaced = false;
		const rendered = lines.map((line: string) => {
			if (!symbolPlaced && stripAnsi(line).trim()) {
				symbolPlaced = true;
				return ` ${prefix} ${line}`;
			}
			return `   ${line}`;
		}).map((line) => clampLineWidth(line, safeWidth));
		this.cachedWidth = width;
		this.cachedLines = rendered;
		this.chromeEpoch = deps.toolBranchVisualEpoch();
		return rendered;
	}
}

