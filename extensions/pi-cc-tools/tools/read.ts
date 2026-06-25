// @ts-nocheck
import { createReadTool } from "@earendil-works/pi-coding-agent";

import { codeToAnsiLazy, detectLang, DIFF_THEME } from "../diff/render";
import { withBranch } from "../render/branch";

export function registerReadTool(deps: any): void {
	const {
		pi, cwd, clearBlinkTimer, getFirstImageBlock, makeText, NOWRAP_MARK, previewLimit,
		renderReadImageResult, runningPreviewBlock, safeInvalidate, setToolStatus, sp,
		stableCallSummary, syncToolCallStatus, toolHeader, toolOutputDetailHint, toolStatusDot,
	} = deps;

const readTool = createReadTool(cwd);
pi.registerTool({
	name: "read",
	label: "read",
	description: readTool.description,
	parameters: readTool.parameters,
	async execute(toolCallId, params, signal, onUpdate) {
		return readTool.execute(toolCallId, params, signal, onUpdate);
	},
	renderCall(args, theme, ctx) {
		syncToolCallStatus(ctx);
		if (args.path) {
			try { ctx.state._readFilePath = String(args.path); } catch {}
		}
		if (typeof args.offset === "number") {
			try { ctx.state._readOffset = args.offset; } catch {}
		}
		const summary = stableCallSummary(ctx, "_callSummary", () => {
			let value = sp(args.path ?? "");
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				value += ` ${theme.fg("muted", `(${parts.join(", ")})`)}`;
			}
			return value;
		});
		return makeText(ctx.lastComponent, toolHeader("Read", summary, theme, toolStatusDot(ctx, theme)));
	},
	renderResult(result, { expanded, isPartial }, theme, ctx) {
		if (isPartial) {
			return makeText(ctx.lastComponent, runningPreviewBlock(result, theme.fg("dim", "Reading..."), expanded, theme, ctx));
		}
		clearBlinkTimer(ctx);
		setToolStatus(ctx, ctx.isError ? "error" : "success");
		if (getFirstImageBlock(result)) return renderReadImageResult(result, expanded, theme, ctx);
		const details = result.details as ReadToolDetails | undefined;
		const content = result.content.find((block: any) => block?.type === "text");
		if (content?.type !== "text") return makeText(ctx.lastComponent, withBranch(theme.fg("error", "No text content"), theme));
		const lines = content.text.split("\n");
		const loadInfo = theme.fg("muted", `${lines.length} lines loaded`)
			+ (details?.truncation?.truncated ? theme.fg("warning", " (truncated)") : "");
		if (!expanded) return makeText(ctx.lastComponent, withBranch(`${loadInfo}${toolOutputDetailHint(theme, expanded)}`, theme));

		// Build line-numbered content
		const shown = lines.slice(0, previewLimit());
		const totalLines = lines.length;
		const nw = Math.max(3, String(totalLines).length);
		const filePath = ((ctx.state as any)?._readFilePath as string) ?? "";
		const offset = ((ctx.state as any)?._readOffset as number) ?? 0;
		const readHLKey = `${filePath}\0${offset}\0${previewLimit()}\0${DIFF_THEME}\0${content.text.length}\0${shown.join("\n")}`;

		// Use cached highlighted text only for this exact read slice.
		const cachedHL = (ctx.state as any)?._readHLKey === readHLKey
			? ((ctx.state as any)?._readHL as string | undefined)
			: undefined;

		let codeBody: string;
		if (cachedHL) {
			codeBody = cachedHL;
		} else {
			const codeLines = shown.map((line: string, i: number) => {
				const ln = offset + i + 1;
				const lineNo = String(ln).padStart(nw);
				return `${NOWRAP_MARK}${theme.fg("muted", lineNo)} ${theme.fg("dim", "│")} ${theme.fg("dim", line || " ")}`;
			});
			codeBody = codeLines.join("\n");
			if (totalLines > shown.length) {
				codeBody += `\n${theme.fg("muted", `… ${totalLines - shown.length} more lines`)}${toolOutputDetailHint(theme, expanded)}`;
			}
		}

		const fullContent = `${loadInfo}\n${codeBody}`;
		const textComp = makeText(ctx.lastComponent, withBranch(fullContent, theme));

		// Async Shiki syntax highlighting (one in-flight render per read slice).
		if (!cachedHL) {
			const lang = detectLang(filePath);
			if (lang && (ctx.state as any)?._readHLPendingKey !== readHLKey) {
				try { (ctx.state as any)._readHLPendingKey = readHLKey; } catch {}
				codeToAnsiLazy(shown.join("\n"), lang, DIFF_THEME).then((ansi) => {
					if ((ctx.state as any)?._readHLPendingKey !== readHLKey) return;
					const hlLines = ansi.split("\n");
					if (hlLines.length === 0) return;
					const hlCode = hlLines.map((hlLine: string, i: number) => {
						const ln = offset + i + 1;
						const lineNo = String(ln).padStart(nw);
						return `${NOWRAP_MARK}${theme.fg("muted", lineNo)} ${theme.fg("dim", "│")} ${hlLine || " "}`;
					}).join("\n");
					let hlBody = hlCode;
					if (totalLines > shown.length) {
						hlBody += `\n${theme.fg("muted", `… ${totalLines - shown.length} more lines`)}${toolOutputDetailHint(theme, expanded)}`;
					}
					try {
						(ctx.state as any)._readHLKey = readHLKey;
						(ctx.state as any)._readHL = hlBody;
						delete (ctx.state as any)._readHLPendingKey;
					} catch {}
					textComp.setText(withBranch(`${loadInfo}\n${hlBody}`, theme));
					safeInvalidate(ctx);
				}).catch(() => {
					try {
						if ((ctx.state as any)?._readHLPendingKey === readHLKey) delete (ctx.state as any)._readHLPendingKey;
					} catch {}
				});
			}
		}

		return textComp;
	},
});
}
