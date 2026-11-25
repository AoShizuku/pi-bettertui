import {
	AssistantMessageComponent,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Markdown,
	MouseRegion,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";

import type { BetterTuiConfig } from "./config.js";
import { clickSegment, paintSegment } from "./fold-view.js";
import { formatDuration, tailThinkingRows, thoughtLabel } from "./format.js";
import { applyAssistantGutter, GUTTER } from "./gutter.js";
import { type InterruptNoteHooks, replaceInterruptNote } from "./interrupt.js";
import { thinkingAnchor, thinkingRuns, type ThinkingRun } from "./segment.js";
import type { ActivityTimeline } from "./timeline.js";

const PATCH_KEY = Symbol.for("pi-bettertui.thinking");
/** The header starts in the gutter's content column (DESIGN.md §2.1). */
const HEADER_INDENT = GUTTER;
const HEADER_PAD = " ".repeat(HEADER_INDENT);
/** The streaming tail and the expanded thought sit two columns further in, under the header. */
const BODY_INDENT = GUTTER + 2;
const BODY_PAD = " ".repeat(BODY_INDENT);
const expandedState = new WeakMap<object, boolean>();
/** Identifies patches made by this module instance; each /reload loads a new one. */
const MODULE_OWNER = {};
/** Undo functions of every prototype patched by this module instance. */
const cleanups = new Set<() => void>();

export interface ThinkingPatchHooks {
	/** The plugin as a whole: the gutter applies even when thinking is left to pi. */
	isEnabled: () => boolean;
	/** Thinking window height; 0 keeps pi's native thinking block. */
	getLines: () => number;
	getTheme: () => Theme;
	getActiveTui: () => TUI | undefined;
	/** Fold segments (fold-more.md §5.6); absent or with fold off, thinking renders as before. */
	fold?: FoldHooks;
	/** pi's abort note under an aborted message (DESIGN.md §9); absent, pi's note stays. */
	interrupt?: InterruptNoteHooks;
}

export interface FoldHooks {
	timeline: ActivityTimeline;
	getConfig: () => BetterTuiConfig;
	getCwd: () => string;
}

interface PatchRecord {
	/** Missing on patches from builds before the owner check. */
	owner?: object;
	hooks: ThinkingPatchHooks;
	originalUpdateContent: (...args: any[]) => any;
	originalSetHideThinkingBlock: (...args: any[]) => any;
	patchedUpdateContent: (...args: any[]) => any;
	patchedSetHideThinkingBlock: (...args: any[]) => any;
}

interface ThinkingViewOptions {
	text: string;
	streaming: boolean;
	expanded: boolean;
	startedAt: number;
	durationMs: number;
	pad: number;
	getTheme: () => Theme;
	lineCount: number;
}

export class ThinkingView implements Component {
	private text: string;
	private streaming: boolean;
	private expanded: boolean;
	private startedAt: number;
	private durationMs: number;
	private pad: number;
	private getTheme: () => Theme;
	private lineCount: number;
	private markdown?: Markdown;
	private markdownText = "";
	private markdownTheme?: ReturnType<typeof getMarkdownTheme>;
	private markdownPalette = "";

	constructor(options: ThinkingViewOptions) {
		this.text = options.text;
		this.streaming = options.streaming;
		this.expanded = options.expanded;
		this.startedAt = options.startedAt;
		this.durationMs = options.durationMs;
		this.pad = options.pad;
		this.getTheme = options.getTheme;
		this.lineCount = options.lineCount;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.getTheme();
		const pad = " ".repeat(Math.max(0, this.pad));
		const duration = this.streaming
			? Math.max(0, Date.now() - this.startedAt)
			: this.durationMs;
		const header = truncateToWidth(this.renderHeader(theme, duration), width, "…");
		if (this.expanded) {
			return [header, ...this.renderExpanded(width, pad, theme)];
		}
		if (this.streaming) {
			return [header, ...this.renderTail(width, pad, theme)];
		}
		return [header];
	}

	invalidate(): void {
		this.markdown = undefined;
		this.markdownText = "";
		this.markdownPalette = "";
	}

	/**
	 * A process line, not an event (DESIGN.md §2.1): no marker, the gutter's column 0 stays blank
	 * and the whole line is dim from the content column on.
	 */
	private renderHeader(theme: Theme, duration: number): string {
		const label = this.streaming ? "Thinking…" : thoughtLabel(duration);
		const elapsed = this.streaming && duration >= 1_000 ? ` ${formatDuration(duration)}` : "";
		return `${" ".repeat(Math.max(0, this.pad) + HEADER_INDENT)}${theme.fg("dim", label + elapsed)}`;
	}

	private renderTail(width: number, pad: string, theme: Theme): string[] {
		// Wrapped rows, not clipped lines (DESIGN.md §2.1). The "… " for hidden rows hangs in the two
		// columns between the header and the body, so the wrap width is the same whether or not it shows.
		const contentWidth = Math.max(1, width - this.pad - BODY_INDENT);
		const { rows, hidden } = tailThinkingRows(this.text, Math.max(1, this.lineCount), contentWidth);
		const output: string[] = [];
		for (let index = 0; index < this.lineCount; index++) {
			const row = rows[index];
			if (row === undefined) {
				output.push("");
				continue;
			}
			const lead = hidden && index === 0 ? "… " : "  ";
			output.push(`${pad}${HEADER_PAD}${theme.italic(theme.fg("thinkingText", lead + row))}`);
		}
		return output;
	}

	private renderExpanded(width: number, pad: string, theme: Theme): string[] {
		const markdownTheme = getMarkdownTheme();
		const palette = [theme.fg("thinkingText", "x"), theme.bold("x"), theme.italic("x")].join("|");
		if (
			!this.markdown ||
			this.markdownText !== this.text ||
			this.markdownTheme !== markdownTheme ||
			this.markdownPalette !== palette
		) {
			this.markdown = new Markdown(this.text, 0, 0, markdownTheme, {
				color: (line: string) => theme.fg("thinkingText", line),
				italic: true,
			});
			this.markdownText = this.text;
			this.markdownTheme = markdownTheme;
			this.markdownPalette = palette;
		}
		const contentWidth = Math.max(1, width - this.pad - BODY_INDENT);
		const lines = this.markdown.render(contentWidth);
		return lines.map((line) => truncateToWidth(`${pad}${BODY_PAD}${line}`, width, "…"));
	}
}

export function installThinkingPatch(hooks: ThinkingPatchHooks): () => void {
	return patchPrototype(AssistantMessageComponent.prototype as any, hooks);
}

/**
 * Pi loads extensions through its own module instance. Importing
 * `AssistantMessageComponent` here can therefore give us a different class
 * object than the one pi renders. Find the live instances in the TUI tree and
 * patch their actual prototype, then rebuild what is already on screen.
 */
export function installLiveThinkingPatch(tui: unknown, hooks: ThinkingPatchHooks): boolean {
	const components = collectAssistantComponents(tui);
	if (components.length === 0) return false;
	const prototypes = new Set<object>();
	for (const component of components) {
		const proto = Object.getPrototypeOf(component);
		if (proto && typeof proto === "object") prototypes.add(proto);
	}
	for (const proto of prototypes) patchPrototype(proto as any, hooks);
	for (const component of components) {
		const lastMessage = (component as any).lastMessage;
		if (lastMessage) (component as any).updateContent(lastMessage, Boolean((component as any).isStreaming));
	}
	return true;
}

/** Restore pi's own methods on every prototype this module instance patched (shutdown or reload). */
export function uninstallThinkingPatches(): void {
	for (const cleanup of [...cleanups]) cleanup();
	cleanups.clear();
}

/** Remove a patch left behind by an earlier load of this extension, if pi still runs it. */
function unwrapStale(proto: any, record: PatchRecord): void {
	if (proto.updateContent === record.patchedUpdateContent) proto.updateContent = record.originalUpdateContent;
	if (proto.setHideThinkingBlock === record.patchedSetHideThinkingBlock) {
		proto.setHideThinkingBlock = record.originalSetHideThinkingBlock;
	}
	proto[PATCH_KEY] = undefined;
}

function patchPrototype(proto: any, hooks: ThinkingPatchHooks): () => void {
	const existing = proto[PATCH_KEY] as PatchRecord | undefined;
	if (existing?.owner === MODULE_OWNER) {
		existing.hooks = hooks;
		return () => {};
	}
	// The patch lives on pi's prototype and outlives a /reload; the earlier module's code would
	// keep rendering with the old layout, so take it off before installing this module's.
	if (existing) unwrapStale(proto, existing);

	const originalUpdateContent = proto.updateContent;
	const originalSetHideThinkingBlock = proto.setHideThinkingBlock;
	if (typeof originalUpdateContent !== "function" || typeof originalSetHideThinkingBlock !== "function") {
		return () => {};
	}

	// Read hooks through the record: a later install in this module instance replaces them.
	const patchedUpdateContent = function (this: any, message: any, isStreaming = this.isStreaming): any {
		if (!expandedState.has(this)) expandedState.set(this, false);
		const result = originalUpdateContent.call(this, message, isStreaming);
		const current = record.hooks;
		const enabled = current.isEnabled();
		// Order matters (fold-more.md §5.6): place the blocks first, so the slots below find their
		// segment; the gutter runs last and must not see a slot as padded text.
		const fold = enabled && current.fold?.timeline.foldEnabled ? current.fold : undefined;
		fold?.timeline.ingestAssistant(message, Boolean(isStreaming));
		if (enabled && current.getLines() > 0) decorateThinking(this, message, Boolean(isStreaming), current, fold);
		applyAssistantGutter(this, enabled, current.getTheme);
		if (enabled && current.interrupt) replaceInterruptNote(this, message, current.interrupt);
		return result;
	};

	const patchedSetHideThinkingBlock = function (this: any, hide: boolean): any {
		// Pi's Ctrl+T toggles this flag. Reuse it as "show details": the first
		// press (hide=true) expands the thought this plugin collapsed by default.
		expandedState.set(this, hide);
		const fold = record.hooks.fold;
		if (fold) fold.timeline.thinkingDetails = hide;
		return originalSetHideThinkingBlock.call(this, hide);
	};

	const record: PatchRecord = {
		owner: MODULE_OWNER,
		hooks,
		originalUpdateContent,
		originalSetHideThinkingBlock,
		patchedUpdateContent,
		patchedSetHideThinkingBlock,
	};
	proto[PATCH_KEY] = record;
	proto.updateContent = patchedUpdateContent;
	proto.setHideThinkingBlock = patchedSetHideThinkingBlock;

	const cleanup = (): void => {
		cleanups.delete(cleanup);
		if (proto[PATCH_KEY] !== record) return;
		unwrapStale(proto, record);
	};
	cleanups.add(cleanup);
	return cleanup;
}

function collectAssistantComponents(root: unknown): any[] {
	const out: any[] = [];
	const stack: unknown[] = [root];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const value = stack.pop();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		const candidate = value as any;
		if (
			candidate.contentContainer &&
			typeof candidate.updateContent === "function" &&
			typeof candidate.setHideThinkingBlock === "function" &&
			candidate.lastMessage?.role === "assistant"
		) {
			out.push(candidate);
		}
		if (Array.isArray(candidate.children)) {
			for (const child of candidate.children) stack.push(child);
		}
		if (candidate.child) stack.push(candidate.child);
	}
	return out;
}

function decorateThinking(
	component: any,
	message: any,
	streaming: boolean,
	hooks: ThinkingPatchHooks,
	fold?: FoldHooks,
): void {
	const container = component.contentContainer;
	if (!container || !Array.isArray(container.children)) return;
	const runs = regionRuns(component, message);
	if (runs.length === 0) return;

	const regions = container.children.filter(isThinkingRegion);
	if (regions.length === 0) return;
	const timestamp = typeof message?.timestamp === "number" ? message.timestamp : undefined;

	const expanded = expandedState.get(component) ?? false;
	const phaseStreaming = streaming && !hasAnswer(message);
	const startedAt = typeof message?.timestamp === "number" ? message.timestamp : Date.now();
	const durationMs = typeof message?.durationMs === "number"
		? message.durationMs
		: streaming
			? Math.max(0, Date.now() - startedAt)
			: 0;
	for (let index = 0; index < regions.length; index++) {
		const region = regions[index]!;
		// pi draws one region per run with text, minus hidden runs when the hidden label is empty.
		const run = runs[index];
		if (!run) continue;
		const text = run.text;
		const view = new ThinkingView({
			text,
			streaming: phaseStreaming,
			expanded,
			startedAt,
			durationMs,
			// Laid out on the shared gutter (DESIGN.md §2), whatever pi's outputPad is.
			pad: 0,
			getTheme: hooks.getTheme,
			lineCount: hooks.getLines(),
		});
		const wrapped = new MouseRegion(view, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			expandedState.set(component, !(expandedState.get(component) ?? false));
			const lastMessage = component.lastMessage;
			if (lastMessage) component.updateContent(lastMessage, Boolean(component.isStreaming));
			hooks.getActiveTui()?.requestRender();
			return { handled: true };
		});
		// With fold on, the slot decides on every render whether it draws this view, its whole
		// segment, or nothing (fold-more.md §5.6).
		const slot = fold && timestamp !== undefined
			? new ThinkingSlot(thinkingAnchor(timestamp, run.runIndex), wrapped, fold, hooks)
			: wrapped;
		const childIndex = container.children.indexOf(region);
		if (childIndex >= 0) container.children[childIndex] = slot;
	}
	// pi's blank lines stay where pi puts them, including the one between a thought and the text
	// after it; under fold they only drop next to slots that draw nothing.
	if (fold) replaceSpacersWithGaps(container);
}

/**
 * The runs pi draws a region for, in order (fold-more.md §2.3): every run with text gets a run
 * index, but a hidden run gets no region when the hidden label is empty.
 */
export function regionRuns(component: any, message: unknown): ThinkingRun[] {
	const runs = thinkingRuns((message as { content?: unknown } | undefined)?.content);
	const hideAll = component?.hideThinkingBlock === true;
	const label = typeof component?.hiddenThinkingLabel === "string" ? component.hiddenThinkingLabel : "Thinking...";
	if (label.trim()) return runs;
	const overrides = component?.thinkingVisibilityOverrides;
	const override = (run: number): boolean | undefined =>
		overrides && typeof overrides.get === "function" ? overrides.get(run) : undefined;
	return runs.filter((run) => !(override(run.runIndex) ?? hideAll));
}

/** A thinking region under fold: its own view, its segment's host output, or nothing. */
export class ThinkingSlot implements Component {
	private targets: string[] = [];

	constructor(
		readonly anchor: string,
		private readonly view: Component,
		private readonly fold: FoldHooks,
		private readonly hooks: ThinkingPatchHooks,
	) {}

	/** Whether this slot draws anything; spacers before it only show when something does. */
	visible(): boolean {
		return this.fold.timeline.foldRole(this.anchor).kind !== "hidden";
	}

	render(width: number): string[] {
		const role = this.fold.timeline.foldRole(this.anchor);
		if (role.kind === "hidden") return [];
		if (role.kind === "single") return [...this.view.render(width)];
		const paint = paintSegment(role.segment, width, {
			timeline: this.fold.timeline,
			config: this.fold.getConfig(),
			theme: this.hooks.getTheme(),
			cwd: this.fold.getCwd(),
			expanded: this.fold.timeline.globalExpanded,
		});
		this.targets = paint.targets;
		return paint.lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const role = this.fold.timeline.foldRole(this.anchor);
		if (role.kind === "hidden") return undefined;
		if (role.kind === "single") return this.view.handleMouse?.(event) as TuiMouseEventResult | undefined;
		if (event.type !== "click" || event.button !== "left") return undefined;
		const timeline = this.fold.timeline;
		if (!clickSegment(timeline, role.segment, this.targets, event.y)) return undefined;
		this.hooks.getActiveTui()?.requestRender();
		return { handled: true };
	}

	invalidate(): void {
		this.view.invalidate();
	}
}

/**
 * pi's blank line before a visible block, drawn only when something visible follows it in the
 * same message before the next gap (fold-more.md §5.6). A message whose slots are all hidden
 * then takes no lines at all, and a hidden slot between two gaps does not leave two blank lines.
 */
export class GapSlot implements Component {
	constructor(private readonly siblings: { children: unknown[] }) {}

	render(_width: number): string[] {
		const children = this.siblings.children;
		const index = children.indexOf(this);
		if (index < 0) return [""];
		for (let next = index + 1; next < children.length; next++) {
			const child = children[next];
			if (child instanceof GapSlot) return [];
			if (child instanceof ThinkingSlot && !child.visible()) continue;
			return [""];
		}
		return [];
	}

	invalidate(): void {}
}

function replaceSpacersWithGaps(container: { children: unknown[] }): void {
	const children = container.children;
	for (let index = 0; index < children.length; index++) {
		const child = children[index] as { lines?: unknown };
		if (isSpacer(child) && child.lines === 1) children[index] = new GapSlot(container);
	}
}

/**
 * pi-tui's Spacer: a line count, `setLines`, and a render that yields only empty lines. pi may
 * load pi-tui through another module instance, so match the shape rather than the class.
 */
export function isSpacer(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { lines?: unknown; setLines?: unknown; render?: unknown };
	if (typeof candidate.lines !== "number" || candidate.lines < 1) return false;
	if (typeof candidate.setLines !== "function" || typeof candidate.render !== "function") return false;
	// Containers and padded text also render blank lines; a spacer has neither children nor content.
	if ("children" in candidate || "child" in candidate || "text" in candidate) return false;
	let lines: unknown;
	try {
		lines = (candidate.render as (width: number) => unknown).call(candidate, 1);
	} catch {
		return false;
	}
	return Array.isArray(lines) && lines.length === candidate.lines && lines.every((line) => line === "");
}

function isThinkingRegion(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const region = value as { child?: unknown; onMouse?: unknown };
	return Boolean(region.child && typeof region.onMouse === "function");
}

export function collectThinkingRuns(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const runs: string[] = [];
	let current: string[] = [];
	const flush = () => {
		const text = current.join("\n\n").trim();
		if (text) runs.push(text);
		current = [];
	};
	for (const item of content) {
		if (!item || typeof item !== "object") {
			flush();
			continue;
		}
		const block = item as { type?: unknown; thinking?: unknown; text?: unknown };
		if (block.type === "thinking") {
			const text = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
			if (text.trim()) current.push(text);
		} else {
			flush();
		}
	}
	flush();
	return runs;
}

export function hasAnswer(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((item) => {
		if (!item || typeof item !== "object") return false;
		const block = item as { type?: unknown; text?: unknown };
		if (block.type === "toolCall") return true;
		return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
	});
}
