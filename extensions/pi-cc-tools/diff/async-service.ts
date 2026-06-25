import { readFile as readFileAsync } from "node:fs/promises";
import { resolve } from "node:path";

import { countDiffHunks, getFirstChangedNewLine, offsetParsedDiff, parseDiff } from "./parse";
import { summarizeEditOperations } from "./summary";
import type { AsyncDiffData, AsyncDiffJob, EditOperation, LocalizedEditDiff, PendingAsyncDiffJob } from "./types";

export const STREAM_EDIT_DIFF_MAX_LINES = 300;
export const STREAM_EDIT_DIFF_MAX_CHARS = 30_000;
export const ASYNC_DIFF_TIMEOUT_MS = 5_000;
const CACHE_LIMIT = 48;

function unrefTimer(timer: ReturnType<typeof setTimeout> | null | undefined): void {
	(timer as any)?.unref?.();
}

export function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripBomText(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

export function normalizeTextForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function findEditMatch(content: string, oldText: string): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean } {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
	const fuzzyContent = normalizeTextForFuzzyMatch(content);
	const fuzzyOldText = normalizeTextForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	return fuzzyIndex === -1
		? { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false }
		: { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

export function countFuzzyOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeTextForFuzzyMatch(content);
	const fuzzyOldText = normalizeTextForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

export function lineNumberAtIndex(text: string, index: number): number {
	return text.slice(0, Math.max(0, index)).split("\n").length;
}

export function countLineBreaks(text: string): number {
	return (text.match(/\n/g) ?? []).length;
}

export function textDiffSize(oldText: string, newText: string): { lines: number; chars: number } {
	return {
		lines: Math.max(countLineBreaks(oldText) + 1, countLineBreaks(newText) + 1),
		chars: oldText.length + newText.length,
	};
}

export function editOperationSize(operations: EditOperation[]): { lines: number; chars: number } {
	let lines = 0;
	let chars = 0;
	for (const edit of operations) {
		const size = textDiffSize(edit.oldText, edit.newText);
		lines += size.lines;
		chars += size.chars;
	}
	return { lines, chars };
}

export function isLargeStreamingDiffSize(size: { lines: number; chars: number }): boolean {
	return size.lines > STREAM_EDIT_DIFF_MAX_LINES || size.chars > STREAM_EDIT_DIFF_MAX_CHARS;
}

export function shouldDeferLargeEditDiff(ctx: any, _parseKey: string, operations: EditOperation[]): boolean {
	const size = editOperationSize(operations);
	if (!isLargeStreamingDiffSize(size)) return false;
	return !(ctx?.argsComplete === true || ctx?.executionStarted === true);
}

export function shouldDeferLargeWriteDiff(ctx: any, _parseKey: string, oldText: string, newText: string): boolean {
	if (!isLargeStreamingDiffSize(textDiffSize(oldText, newText))) return false;
	return !(ctx?.argsComplete === true || ctx?.executionStarted === true);
}

export class AsyncDiffService {
	private order = 0;
	private active = false;
	private pumpTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingByChannel = new Map<string, PendingAsyncDiffJob>();
	private latestKeyByChannel = new Map<string, string>();
	private cache = new Map<string, AsyncDiffData>();
	private errors = new Map<string, string>();
	private listeners = new Map<string, Set<(data: AsyncDiffData) => void>>();

	constructor(private readonly formatSummary: (added: number, removed: number) => string = (added, removed) => {
		const parts: string[] = [];
		if (added > 0) parts.push(`+${added}`);
		if (removed > 0) parts.push(`-${removed}`);
		return parts.length ? parts.join(" ") : "no changes";
	}) {}

	get<T extends AsyncDiffData>(key: string): T | undefined {
		const hit = this.cache.get(key);
		if (!hit) return undefined;
		this.cache.delete(key);
		this.cache.set(key, hit);
		this.errors.delete(key);
		return hit as T;
	}

	getError(key: string): string | undefined {
		return this.errors.get(key);
	}

	requestLatest(job: AsyncDiffJob, options: { channel: string; onComplete?: () => void }): boolean {
		if (this.get(job.key)) return true;
		if (options.onComplete) this.addListener(job.key, () => options.onComplete?.());
		const channel = options.channel;
		const previousLatest = this.latestKeyByChannel.get(channel);
		if (previousLatest && previousLatest !== job.key) this.clearListeners(previousLatest);
		this.errors.delete(job.key);
		this.latestKeyByChannel.set(channel, job.key);
		this.pendingByChannel.set(channel, {
			channel,
			job: { ...job, channel } as AsyncDiffJob,
			order: ++this.order,
		});
		this.schedulePump();
		return true;
	}

	compute<T extends AsyncDiffData>(job: AsyncDiffJob, channel: string, timeoutMs = ASYNC_DIFF_TIMEOUT_MS + 1_000): Promise<T> {
		const cached = this.get<T>(job.key);
		if (cached) return Promise.resolve(cached);
		return new Promise((resolvePromise, rejectPromise) => {
			let settled = false;
			const cleanup = this.addListener(job.key, (data) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cleanup();
				resolvePromise(data as T);
			});
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				rejectPromise(new Error("diff compute timed out"));
			}, timeoutMs);
			unrefTimer(timer);
			this.requestLatest(job, { channel });
		});
	}

	dispose(): void {
		if (this.pumpTimer) clearTimeout(this.pumpTimer);
		this.pumpTimer = null;
		this.pendingByChannel.clear();
		this.latestKeyByChannel.clear();
		this.errors.clear();
		this.listeners.clear();
		this.active = false;
	}

	private addListener(key: string, listener: (data: AsyncDiffData) => void): () => void {
		let set = this.listeners.get(key);
		if (!set) {
			set = new Set();
			this.listeners.set(key, set);
		}
		set.add(listener);
		return () => {
			const current = this.listeners.get(key);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.listeners.delete(key);
		};
	}

	private clearListeners(key: string): void {
		this.listeners.delete(key);
	}

	private notify(key: string, data: AsyncDiffData): void {
		const listeners = this.listeners.get(key);
		this.listeners.delete(key);
		if (!listeners) return;
		for (const listener of listeners) {
			try { listener(data); } catch {}
		}
	}

	private setCache(key: string, data: AsyncDiffData): void {
		this.cache.delete(key);
		this.cache.set(key, data);
		while (this.cache.size > CACHE_LIMIT) {
			const first = this.cache.keys().next().value;
			if (first === undefined) break;
			this.cache.delete(first);
		}
	}

	private schedulePump(): void {
		if (this.active || this.pumpTimer || this.pendingByChannel.size === 0) return;
		this.pumpTimer = setTimeout(() => {
			this.pumpTimer = null;
			void this.pump();
		}, 0);
		unrefTimer(this.pumpTimer);
	}

	private async pump(): Promise<void> {
		if (this.active || this.pendingByChannel.size === 0) return;
		const pending = Array.from(this.pendingByChannel.values()).sort((a, b) => b.order - a.order)[0];
		this.pendingByChannel.delete(pending.channel);
		this.active = true;
		try {
			const data = await this.computeJob(pending.job);
			const isLatest = this.latestKeyByChannel.get(pending.channel) === pending.job.key;
			if (isLatest) {
				this.errors.delete(pending.job.key);
				this.setCache(pending.job.key, data);
				this.notify(pending.job.key, data);
			} else {
				this.clearListeners(pending.job.key);
			}
		} catch (error) {
			const isLatest = this.latestKeyByChannel.get(pending.channel) === pending.job.key;
			if (isLatest) this.errors.set(pending.job.key, error instanceof Error ? error.message : String(error));
			this.clearListeners(pending.job.key);
		} finally {
			this.active = false;
			this.schedulePump();
		}
	}

	private async computeJob(job: AsyncDiffJob): Promise<AsyncDiffData> {
		if (job.kind === "write-diff") {
			const diff = parseDiff(job.oldText ?? "", job.newText ?? "");
			return { kind: "write-diff", key: job.key, diff, hunks: countDiffHunks(diff), added: diff.added, removed: diff.removed };
		}
		const summary = summarizeEditOperations(job.operations, this.formatSummary);
		const localizedDiffs = await computeLocalizedEditDiffs(job.filePath, job.operations, job.cwd);
		return {
			kind: "edit-diff",
			key: job.key,
			...summary,
			localizedDiffs,
			lines: (localizedDiffs ?? summary.diffs.map((diff) => ({ diff, line: getFirstChangedNewLine(diff) }))).map((entry) => entry.line),
		};
	}
}

export async function computeLocalizedEditDiffs(filePath: string, operations: EditOperation[], cwd: string): Promise<LocalizedEditDiff[] | null> {
	if (!filePath || operations.length === 0) return null;
	try {
		const rawContent = await readFileAsync(resolve(cwd, filePath), "utf8");
		const normalizedContent = normalizeToLf(stripBomText(rawContent));
		const normalizedOps = operations.map((edit) => ({ oldText: normalizeToLf(edit.oldText), newText: normalizeToLf(edit.newText) }));
		const baseContent = normalizedOps.some((edit) => findEditMatch(normalizedContent, edit.oldText).usedFuzzyMatch)
			? normalizeTextForFuzzyMatch(normalizedContent)
			: normalizedContent;
		const matches = normalizedOps.map((edit, editIndex) => {
			const match = findEditMatch(baseContent, edit.oldText);
			if (!match.found || countFuzzyOccurrences(baseContent, edit.oldText) !== 1) return null;
			return { editIndex, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText };
		});
		if (matches.some((match) => match === null)) return null;
		const ordered = [...(matches as Array<{ editIndex: number; matchIndex: number; matchLength: number; newText: string }>)].sort((a, b) => a.matchIndex - b.matchIndex);
		for (let i = 1; i < ordered.length; i++) {
			const prev = ordered[i - 1];
			const current = ordered[i];
			if (prev.matchIndex + prev.matchLength > current.matchIndex) return null;
		}
		const localized: Array<LocalizedEditDiff | null> = Array(operations.length).fill(null);
		let lineDelta = 0;
		for (const match of ordered) {
			const oldChunk = baseContent.slice(match.matchIndex, match.matchIndex + match.matchLength);
			const oldStartLine = lineNumberAtIndex(baseContent, match.matchIndex);
			const newStartLine = oldStartLine + lineDelta;
			const diff = offsetParsedDiff(parseDiff(oldChunk, match.newText), oldStartLine - 1, newStartLine - 1);
			localized[match.editIndex] = { diff, line: getFirstChangedNewLine(diff) };
			lineDelta += countLineBreaks(match.newText) - countLineBreaks(oldChunk);
		}
		return localized.every(Boolean) ? (localized as LocalizedEditDiff[]) : null;
	} catch {
		return null;
	}
}
