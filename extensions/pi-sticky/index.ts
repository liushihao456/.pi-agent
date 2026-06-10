import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFixedEditorCluster } from "./cluster.ts";
import {
	emergencyTerminalModeReset,
	TerminalSplitCompositor,
	type TerminalLike,
} from "./terminal-split.ts";

interface ContainerLike extends Component {
	children: Component[];
}

interface TuiLike {
	children: Component[];
	terminal?: TerminalLike;
	focusedComponent?: Component | null;
	requestRender: (force?: boolean) => void;
	getShowHardwareCursor?: () => boolean;
}

interface ContainerMatch {
	container: ContainerLike;
	index: number;
}

const WIDGET_KEY = "pi-sticky-probe";
const WARNING_MESSAGE = "pi-sticky: unsupported Pi TUI layout";

let compositor: TerminalSplitCompositor | null = null;
let tuiRef: TuiLike | null = null;
let isInstalled = false;
let didWarnUnsupported = false;
let fixedStatusContainer: Component | null = null;
let fixedWidgetContainerAbove: Component | null = null;
let fixedEditorContainer: Component | null = null;
let fixedWidgetContainerBelow: Component | null = null;
let fixedFooterContainer: Component | null = null;

class ProbeComponent implements Component {
	private queued = false;
	constructor(private readonly install: () => void) {}
	render(): string[] {
		if (!this.queued) {
			this.queued = true;
			queueMicrotask(this.install);
		}
		return [];
	}
	invalidate(): void {
		this.queued = false;
	}
}

function isContainerLike(value: unknown): value is ContainerLike {
	return Boolean(
		value &&
			typeof value === "object" &&
			Array.isArray(Reflect.get(value, "children")) &&
			typeof Reflect.get(value, "render") === "function",
	);
}

function isRenderable(value: unknown): value is Component {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof Reflect.get(value, "render") === "function" &&
			typeof Reflect.get(value, "invalidate") === "function",
	);
}

function getTuiChildren(tui: TuiLike): Component[] {
	return Array.isArray(tui.children) ? tui.children : [];
}

function findContainerWithChild(
	tui: TuiLike,
	child: Component,
): ContainerMatch | null {
	const children = getTuiChildren(tui);
	const index = children.findIndex(
		(candidate) =>
			isContainerLike(candidate) && candidate.children.includes(child),
	);
	if (index === -1) return null;
	const container = children[index];
	return isContainerLike(container) ? { container, index } : null;
}

function findEditorContainer(tui: TuiLike): ContainerMatch | null {
	const focusedComponent = Reflect.get(tui, "focusedComponent");
	if (isRenderable(focusedComponent)) {
		const match = findContainerWithChild(tui, focusedComponent);
		if (match) return match;
	}

	const children = getTuiChildren(tui);
	const index = children.findIndex((candidate) => {
		if (!isContainerLike(candidate)) return false;
		return candidate.children.some((child) => {
			return (
				typeof Reflect.get(child, "getText") === "function" &&
				typeof Reflect.get(child, "setText") === "function" &&
				typeof Reflect.get(child, "handleInput") === "function"
			);
		});
	});
	if (index === -1) return null;
	const container = children[index];
	return isContainerLike(container) ? { container, index } : null;
}

function renderHidden(
	active: TerminalSplitCompositor,
	component: Component | null,
	width: number,
): string[] {
	if (!component) return [];
	return active
		.renderHidden(component, width)
		.filter((line) => visibleWidth(line) > 0);
}

function resetContainers(): void {
	fixedStatusContainer = null;
	fixedWidgetContainerAbove = null;
	fixedEditorContainer = null;
	fixedWidgetContainerBelow = null;
	fixedFooterContainer = null;
}

function teardown(options?: { resetExtendedKeyboardModes?: boolean }): void {
	const hadCompositor = compositor !== null;
	compositor?.dispose(options);
	if (!hadCompositor && options?.resetExtendedKeyboardModes) {
		try {
			process.stdout.write(emergencyTerminalModeReset());
		} catch (error) {
			process.stderr.write(
				`[pi-sticky] emergency terminal reset failed: ${String(error)}\n`,
			);
		}
	}
	compositor = null;
	tuiRef = null;
	isInstalled = false;
	resetContainers();
}

function warnUnsupported(ctx: ExtensionContext): void {
	if (didWarnUnsupported || ctx.mode !== "tui") return;
	didWarnUnsupported = true;
	ctx.ui.notify(WARNING_MESSAGE, "warning");
}

function install(ctx: ExtensionContext, tui: TuiLike): void {
	if (isInstalled || compositor) return;
	if (ctx.mode !== "tui") return;
	const terminal = tui.terminal;
	if (!terminal || typeof terminal.write !== "function") {
		warnUnsupported(ctx);
		return;
	}

	const editorMatch = findEditorContainer(tui);
	if (!editorMatch) {
		warnUnsupported(ctx);
		return;
	}

	const children = getTuiChildren(tui);
	fixedStatusContainer = children[editorMatch.index - 2] ?? null;
	fixedWidgetContainerAbove = children[editorMatch.index - 1] ?? null;
	fixedEditorContainer = editorMatch.container;
	fixedWidgetContainerBelow = children[editorMatch.index + 1] ?? null;
	fixedFooterContainer = children[editorMatch.index + 2] ?? null;
	tuiRef = tui;

	let next: TerminalSplitCompositor;
	next = new TerminalSplitCompositor({
		tui,
		terminal,
		keyboardScrollShortcuts: { up: "super+pageup", down: "super+pagedown" },
		onCopySelection: (text) => void copyToClipboard(text),
		getShowHardwareCursor: () =>
			typeof tui.getShowHardwareCursor === "function" &&
			tui.getShowHardwareCursor(),
		renderCluster: (width, terminalRows) =>
			renderFixedEditorCluster({
				width,
				terminalRows,
				statusLines: renderHidden(next, fixedStatusContainer, width),
				topLines: renderHidden(next, fixedWidgetContainerAbove, width),
				editorLines: renderHidden(next, fixedEditorContainer, width),
				secondaryLines: renderHidden(next, fixedWidgetContainerBelow, width),
				transcriptLines: [],
				lastPromptLines: renderHidden(next, fixedFooterContainer, width),
			}),
	});

	compositor = next;
	if (fixedStatusContainer) next.hideRenderable(fixedStatusContainer);
	if (fixedWidgetContainerAbove) next.hideRenderable(fixedWidgetContainerAbove);
	if (fixedEditorContainer) next.hideRenderable(fixedEditorContainer);
	if (fixedWidgetContainerBelow) next.hideRenderable(fixedWidgetContainerBelow);
	if (fixedFooterContainer) next.hideRenderable(fixedFooterContainer);

	try {
		next.install();
		isInstalled = true;
		tui.requestRender(true);
	} catch {
		teardown({ resetExtendedKeyboardModes: true });
		warnUnsupported(ctx);
	}
}

export default function piSticky(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		didWarnUnsupported = false;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) =>
				new ProbeComponent(() => install(ctx, tui as unknown as TuiLike)),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
		teardown({ resetExtendedKeyboardModes: true });
	});
}
