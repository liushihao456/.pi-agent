import type { Theme } from "@earendil-works/pi-coding-agent";

const DEFAULT_TRANSPARENT_RESET = "\x1b[0m\x1b[49m";
const DEFAULT_WRAP_MARK = "\uE000";

type BranchAnsiProvider = (theme?: Theme) => string;

let currentToolBranchAnsi: BranchAnsiProvider = () => "\x1b[38;2;72;72;72m";
let transparentReset = DEFAULT_TRANSPARENT_RESET;
let wrapMark = DEFAULT_WRAP_MARK;

export function configureBranchRenderer(options: {
	currentToolBranchAnsi?: BranchAnsiProvider;
	transparentReset?: string;
	wrapMark?: string;
}): void {
	if (options.currentToolBranchAnsi) currentToolBranchAnsi = options.currentToolBranchAnsi;
	if (options.transparentReset !== undefined) transparentReset = options.transparentReset;
	if (options.wrapMark !== undefined) wrapMark = options.wrapMark;
}

export function branchIndent(text: string, continued = false, theme?: Theme): string {
	const rule = currentToolBranchAnsi(theme);
	const prefix = continued ? `${rule}│${transparentReset}  ` : "   ";
	return `${prefix}${wrapMark}${text}`;
}

export function branchLead(text: string, continued = false, theme?: Theme): string {
	const rule = currentToolBranchAnsi(theme);
	return `${rule}${continued ? "├─" : "└─"}${transparentReset} ${wrapMark}${text}`;
}

export function withBranch(content: string, theme: Theme, _isError = false, continued = false): string {
	if (!content || !content.trim()) return "";
	const lines = content.split("\n");
	const first = lines[0] ?? "";
	if (lines.length === 1) return branchLead(first, continued, theme);
	const rest = lines.slice(1).map((line) => branchIndent(line, continued, theme));
	return `${branchLead(first, continued, theme)}\n${rest.join("\n")}`;
}

export function withFinalBranchBlock(content: string, theme: Theme, _isError = false): string {
	if (!content || !content.trim()) return "";
	const lines = content.split("\n");
	const first = lines[0] ?? "";
	if (lines.length === 1) return branchLead(first, false, theme);
	const middle = lines.slice(1, -1).map((line) => branchIndent(line, true, theme));
	const last = lines[lines.length - 1] ?? "";
	return [branchLead(first, true, theme), ...middle, branchLead(last, false, theme)].join("\n");
}

export function indentBranchBlock(block: string): string {
	return block
		.split("\n")
		.map((line) => (line ? ` ${line}` : line))
		.join("\n");
}
