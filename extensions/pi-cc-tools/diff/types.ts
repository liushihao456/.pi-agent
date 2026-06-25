export interface DiffLine {
	type: "add" | "del" | "ctx" | "sep";
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

export interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
	chars: number;
}

export interface LocalizedEditDiff {
	diff: ParsedDiff;
	line: number;
}

export interface WriteDiffData {
	kind: "write-diff";
	key: string;
	diff: ParsedDiff;
	hunks: number;
	added: number;
	removed: number;
}

export interface EditDiffData {
	kind: "edit-diff";
	key: string;
	diffs: ParsedDiff[];
	totalAdded: number;
	totalRemoved: number;
	totalLines: number;
	totalHunks: number;
	summary: string;
	localizedDiffs: LocalizedEditDiff[] | null;
	lines: number[];
}

export type AsyncDiffData = WriteDiffData | EditDiffData;

export interface EditOperation {
	oldText: string;
	newText: string;
}

export type AsyncDiffJob =
	| { kind: "write-diff"; key: string; channel?: string; oldText: string; newText: string }
	| { kind: "edit-diff"; key: string; channel?: string; filePath: string; cwd: string; operations: EditOperation[] };

export interface PendingAsyncDiffJob {
	channel: string;
	job: AsyncDiffJob;
	order: number;
}

export interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
}
