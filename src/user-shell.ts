import {
	BashExecutionComponent,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type Theme,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { formatDuration, formatElapsed } from "./format.js";
import { isUserMessage } from "./gutter.js";

/**
 * User shell commands (`!cmd` / `!!cmd`) drawn as a rounded box (DESIGN.md §7):
 *
 *   ╭─ ! sh ─────────────────────── exit 0 · 1.2s ─╮
 *   │ git status --short                           │
 *   │  M src/index.ts                              │
 *   ╰─ … 12 more lines ────────────────────────────╯
 *
 * Once a user message sits below a finished block, the block folds to three rows (DESIGN.md §7.4):
 *
 *   ╭─ ! sh ─────────────────────── exit 0 · 1.2s ─╮
 *   │ git status --short                           │
 *   ╰─ … 14 lines · click to show ─────────────────╯
 *
 * pi has no render hook for these (`user_bash` only replaces execution), so the patch takes
 * over `render()` and `handleMouse()` of pi's component and derives the box from its private
 * fields. When a field is missing the component renders exactly as pi draws it.
 */

const PATCH_KEY = Symbol.for("pi-bettertui.user-shell");
/** Timing lives on the instance so it survives a /reload of this module. */
const TIMING_KEY = Symbol.for("pi-bettertui.user-shell.timing");
/** Fold state, on the instance for the same reason. */
const FOLD_KEY = Symbol.for("pi-bettertui.user-shell.fold");
/** Identifies patches made by this module instance; each /reload loads a new one. */
const MODULE_OWNER = {};
/** Undo functions of every prototype patched by this module instance. */
const cleanups = new Set<() => void>();

/** Same preview height as pi: the last 20 lines until Ctrl+O expands the output. */
export const PREVIEW_LINES = 20;
/** Below this width there is no room for `│ x │`; draw the rows without a frame. */
const MIN_BOX_WIDTH = 6;
/** A block that left its container is searched for again at most this often. */
const RESCAN_INTERVAL_MS = 200;

type Status = "running" | "complete" | "cancelled" | "error";
type ColorToken = Parameters<Theme["fg"]>[0];
/** A block with a user message below it: folded to three rows, or opened again by a click. */
export type ShellFold = "folded" | "open";

export interface UserShellHooks {
	isEnabled: () => boolean;
	getTheme: () => Theme;
	/** Key that toggles the output, for the hint in the bottom border. */
	expandKey?: () => string;
	/** Fold finished blocks that have a user message below them. */
	foldAnswered?: () => boolean;
	/** Root of the TUI tree, to find the container a block moved to. */
	getRoot?: () => unknown;
}

/** What the box needs from pi's component. */
export interface UserShellView {
	command: string;
	outputLines: readonly string[];
	status: Status;
	exitCode: number | undefined;
	expanded: boolean;
	/** `!!`: the output never reaches the model. */
	excludeFromContext: boolean;
	truncated: boolean;
	fullOutputPath: string | undefined;
}

export interface UserShellBoxOptions {
	/** Running: time since start. Finished: total run time, unknown for restored history. */
	elapsedMs?: number;
	expandKey?: string;
	/** Only for a block with a user message below it. */
	fold?: ShellFold;
}

interface FoldState {
	/** Set by a click; undefined follows pi's expand toggle. */
	override?: "open" | "closed";
	/** pi's expand toggle at the last render: Ctrl+O hands every block back to the toggle. */
	lastExpanded: boolean;
	/** What the last render drew, for the click handler. */
	mode?: ShellFold;
	/** The last render had something to fold, so a click changes it. */
	toggle: boolean;
	lastRescanAt?: number;
	answered?: { parent: Container; length: number; last: unknown; index: number; value: boolean };
}

interface Container {
	children: unknown[];
}

interface Timing {
	startedAt: number;
	endedAt?: number;
	/** Only a command seen while running has a meaningful duration. */
	sawRunning: boolean;
}

interface PatchRecord {
	owner: object;
	hooks: UserShellHooks;
	/** Whether render was the prototype's own property before the patch (it is inherited in pi). */
	hadOwnRender: boolean;
	original: (this: any, width: number) => string[];
	patched: (this: any, width: number) => string[];
	/** Same for handleMouse (inherited from Container in pi). */
	hadOwnMouse: boolean;
	originalMouse: ((this: any, event: TuiMouseEvent) => TuiMouseEventResult | undefined) | undefined;
	patchedMouse: (this: any, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

interface Body {
	rows: string[];
	bottom: string;
	/** Something is folded away (or would be), so a click changes the block. */
	foldable: boolean;
}

interface BodyCache {
	key: unknown[];
	body: Body;
}

const bodyCache = new WeakMap<object, BodyCache>();
/** The container each block was last found in, to look for a user message below it. */
const parents = new WeakMap<object, Container>();

// ---------------------------------------------------------------------------
// Patch lifecycle
// ---------------------------------------------------------------------------

export function installUserShellPatch(hooks: UserShellHooks): void {
	patchPrototype(BashExecutionComponent.prototype, hooks);
}

/** Restore pi's render on every prototype this module instance patched (shutdown or reload). */
export function uninstallUserShellPatches(): void {
	for (const cleanup of [...cleanups]) cleanup();
	cleanups.clear();
}

/**
 * pi may build the component from a different module instance than the one imported here
 * (see the thinking patch): patch the prototypes of the shell blocks already on screen.
 * The box is derived on every render, so nothing needs rebuilding. Returns how many it found.
 */
export function refreshLiveUserShells(tui: unknown, hooks: UserShellHooks): number {
	const components = collect(tui, isUserShellComponent);
	const prototypes = new Set<object>();
	for (const component of components) {
		const proto = Object.getPrototypeOf(component);
		if (proto && typeof proto === "object") prototypes.add(proto);
	}
	for (const proto of prototypes) patchPrototype(proto, hooks);
	return components.length;
}

function patchPrototype(proto: any, hooks: UserShellHooks): void {
	// Only the shell component's own prototype; never the Container it inherits render from.
	if (!hasOwnFunction(proto, "appendOutput") || !hasOwnFunction(proto, "setComplete")) return;
	const existing = proto[PATCH_KEY] as PatchRecord | undefined;
	if (existing?.owner === MODULE_OWNER) {
		existing.hooks = hooks;
		return;
	}
	// A patch from an earlier load of this extension (/reload) would keep running its old code.
	if (existing) unwrap(proto, existing);

	const original = proto.render;
	if (typeof original !== "function") return;

	const originalMouse = typeof proto.handleMouse === "function" ? proto.handleMouse : undefined;
	const record: PatchRecord = {
		owner: MODULE_OWNER,
		hooks,
		hadOwnRender: Object.prototype.hasOwnProperty.call(proto, "render"),
		original,
		patched: function (this: any, width: number): string[] {
			const view = readUserShell(this);
			if (view) track(this, view.status);
			const current = record.hooks;
			if (!view || !current.isEnabled()) return original.call(this, width);
			try {
				return renderPatched(this, view, width, current);
			} catch {
				return original.call(this, width);
			}
		},
		hadOwnMouse: Object.prototype.hasOwnProperty.call(proto, "handleMouse"),
		originalMouse,
		patchedMouse: function (this: any, event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (record.hooks.isEnabled() && clickFold(this, event)) return { handled: true };
			return originalMouse?.call(this, event);
		},
	};
	proto[PATCH_KEY] = record;
	proto.render = record.patched;
	proto.handleMouse = record.patchedMouse;

	const cleanup = (): void => {
		cleanups.delete(cleanup);
		if (proto[PATCH_KEY] !== record) return;
		unwrap(proto, record);
	};
	cleanups.add(cleanup);
}

function unwrap(proto: any, record: PatchRecord): void {
	if (proto.render === record.patched) {
		if (record.hadOwnRender) proto.render = record.original;
		else delete proto.render;
	}
	if (proto.handleMouse === record.patchedMouse) {
		if (record.hadOwnMouse) proto.handleMouse = record.originalMouse;
		else delete proto.handleMouse;
	}
	proto[PATCH_KEY] = undefined;
}

function hasOwnFunction(target: unknown, name: string): boolean {
	return (
		!!target &&
		typeof target === "object" &&
		Object.prototype.hasOwnProperty.call(target, name) &&
		typeof (target as Record<string, unknown>)[name] === "function"
	);
}

// ---------------------------------------------------------------------------
// Reading pi's component
// ---------------------------------------------------------------------------

const STATUSES: ReadonlySet<unknown> = new Set(["running", "complete", "cancelled", "error"]);

/** Derive the view from pi's private fields; undefined when they do not look like v1.5.0's. */
export function readUserShell(component: unknown): UserShellView | undefined {
	if (!component || typeof component !== "object") return undefined;
	const value = component as Record<string, unknown>;
	const { command, outputLines, status, colorKey } = value;
	if (typeof command !== "string") return undefined;
	if (!Array.isArray(outputLines) || !outputLines.every((line) => typeof line === "string")) return undefined;
	if (!STATUSES.has(status)) return undefined;
	if (colorKey !== "dim" && colorKey !== "bashMode") return undefined;
	const truncation = value.truncationResult as { truncated?: unknown } | undefined;
	return {
		command,
		outputLines,
		status: status as Status,
		exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
		expanded: value.expanded === true,
		excludeFromContext: colorKey === "dim",
		truncated: truncation?.truncated === true,
		fullOutputPath: typeof value.fullOutputPath === "string" && value.fullOutputPath ? value.fullOutputPath : undefined,
	};
}

function isUserShellComponent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as any;
	return (
		typeof candidate.appendOutput === "function" &&
		typeof candidate.setComplete === "function" &&
		typeof candidate.getCommand === "function" &&
		typeof candidate.render === "function" &&
		readUserShell(candidate) !== undefined
	);
}

/**
 * pi builds a restored history entry and completes it in one go, before any render; a live
 * command is rendered while it runs. The first render that sees it finished stamps the end.
 */
function track(component: any, status: Status): void {
	const now = Date.now();
	let timing = component[TIMING_KEY] as Timing | undefined;
	if (!timing) {
		timing = { startedAt: now, sawRunning: status === "running" };
		Object.defineProperty(component, TIMING_KEY, { value: timing, configurable: true, writable: true });
		return;
	}
	if (status === "running") timing.sawRunning = true;
	else if (timing.endedAt === undefined) timing.endedAt = now;
}

function elapsedOf(component: any, status: Status): number | undefined {
	const timing = component[TIMING_KEY] as Timing | undefined;
	if (!timing || !timing.sawRunning) return undefined;
	if (status === "running") return Date.now() - timing.startedAt;
	return timing.endedAt === undefined ? undefined : timing.endedAt - timing.startedAt;
}

function renderPatched(component: any, view: UserShellView, width: number, hooks: UserShellHooks): string[] {
	const theme = hooks.getTheme();
	const fold = foldOf(component, view, hooks);
	const options: UserShellBoxOptions = { elapsedMs: elapsedOf(component, view.status), expandKey: expandKeyOf(hooks), fold };
	const state = component[FOLD_KEY] as FoldState | undefined;
	if (width < MIN_BOX_WIDTH) {
		if (state) {
			state.mode = fold;
			state.toggle = fold !== undefined;
		}
		return renderUserShellBox(view, width, theme, options);
	}

	// The body only changes with the output; the top border ticks every second while running.
	// pi rebuilds its header Text on every change (output, completion, expand, invalidate).
	const revision = Array.isArray(component.contentContainer?.children) ? component.contentContainer.children[0] : undefined;
	const lines = view.outputLines;
	const key: unknown[] = [
		width,
		theme,
		revision,
		view.command,
		view.expanded,
		view.excludeFromContext,
		view.truncated,
		view.fullOutputPath,
		options.expandKey,
		fold,
		lines,
		lines.length,
		lines[lines.length - 1],
	];
	const cached = bodyCache.get(component);
	let body: Body;
	if (cached && cached.key.length === key.length && cached.key.every((part, index) => part === key[index])) {
		body = cached.body;
	} else {
		body = buildBody(view, width, theme, options.expandKey, fold);
		bodyCache.set(component, { key, body });
	}
	if (state) {
		state.mode = fold;
		state.toggle = fold !== undefined && body.foldable;
	}
	return ["", buildTop(view, width, theme, options.elapsedMs), ...body.rows, body.bottom];
}

// ---------------------------------------------------------------------------
// Folding a block that has a user message below it
// ---------------------------------------------------------------------------

/** Undefined unless the block is finished, folding is on and a user message sits below it. */
function foldOf(component: any, view: UserShellView, hooks: UserShellHooks): ShellFold | undefined {
	if (view.status === "running" || !foldEnabled(hooks)) return undefined;
	let state = component[FOLD_KEY] as FoldState | undefined;
	if (!state) {
		state = { lastExpanded: view.expanded, toggle: false };
		Object.defineProperty(component, FOLD_KEY, { value: state, configurable: true, writable: true });
	} else if (state.lastExpanded !== view.expanded) {
		// Ctrl+O speaks for every block: drop what earlier clicks chose.
		state.override = undefined;
		state.lastExpanded = view.expanded;
	}
	if (!answered(component, state, hooks)) return undefined;
	const folded = state.override === "closed" || (state.override === undefined && !view.expanded);
	return folded ? "folded" : "open";
}

function foldEnabled(hooks: UserShellHooks): boolean {
	try {
		return hooks.foldAnswered?.() === true;
	} catch {
		return false;
	}
}

/** A left click on the box (not pi's blank line above it) flips a block that has something to fold. */
function clickFold(component: any, event: TuiMouseEvent): boolean {
	if (event.type !== "click" || event.button !== "left" || event.y < 1) return false;
	const state = component[FOLD_KEY] as FoldState | undefined;
	if (!state?.toggle || !state.mode) return false;
	state.override = state.mode === "folded" ? "open" : "closed";
	return true;
}

/** Whether a user message comes after the block in the container it sits in. */
function answered(component: object, state: FoldState, hooks: UserShellHooks): boolean {
	let parent = parents.get(component);
	let index = parent ? parent.children.indexOf(component) : -1;
	if (index < 0) {
		// Never found, or moved (pi parks `!` typed during a run below the chat, then moves it up).
		const root = rootOf(hooks);
		const now = Date.now();
		if (!root || (state.lastRescanAt !== undefined && now - state.lastRescanAt < RESCAN_INTERVAL_MS)) return false;
		state.lastRescanAt = now;
		collect(root, isUserShellComponent);
		parent = parents.get(component);
		index = parent ? parent.children.indexOf(component) : -1;
		if (!parent || index < 0) return false;
	}
	const children = parent!.children;
	const last = children[children.length - 1];
	const cached = state.answered;
	if (cached && cached.parent === parent && cached.length === children.length && cached.last === last && cached.index === index) {
		return cached.value;
	}
	let value = false;
	for (let i = index + 1; i < children.length; i++) {
		if (isUserMessage(children[i])) {
			value = true;
			break;
		}
	}
	state.answered = { parent: parent!, length: children.length, last, index, value };
	return value;
}

function rootOf(hooks: UserShellHooks): unknown {
	try {
		return hooks.getRoot?.();
	} catch {
		return undefined;
	}
}

function expandKeyOf(hooks: UserShellHooks): string | undefined {
	try {
		const key = hooks.expandKey?.();
		return key ? key : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The whole block: pi's blank separator line, then the box. Rows sit at `│ ` so content
 * starts in the gutter's column 2. Every line fits `width`.
 */
export function renderUserShellBox(
	view: UserShellView,
	width: number,
	theme: Theme,
	options: UserShellBoxOptions = {},
): string[] {
	if (width < MIN_BOX_WIDTH) {
		// No room for a frame: the command and the output, clipped, so nothing overflows.
		const cols = Math.max(0, width);
		const color = colorOf(view);
		const command = commandLines(view.command);
		const rows =
			options.fold === "folded"
				? [theme.fg(color, theme.bold(command[0] ?? ""))]
				: [
						...command.map((line) => theme.fg(color, theme.bold(line))),
						...outputPreview(view).lines.map((line) => theme.fg("muted", line)),
					];
		return ["", ...rows.map((row) => truncateToWidth(row, cols, ""))];
	}
	const body = buildBody(view, width, theme, options.expandKey, options.fold);
	return ["", buildTop(view, width, theme, options.elapsedMs), ...body.rows, body.bottom];
}

function colorOf(view: UserShellView): ColorToken {
	return view.excludeFromContext ? "dim" : "bashMode";
}

function buildTop(view: UserShellView, width: number, theme: Theme, elapsedMs: number | undefined): string {
	const color = colorOf(view);
	const border = (text: string) => theme.fg(color, text);
	const short = view.excludeFromContext ? "!! sh" : "! sh";
	const full = view.excludeFromContext ? "!! sh · 不进上下文" : short;
	const status = statusLabel(view, theme, elapsedMs);

	// Keep the live status before the long title; drop the status before the `!!` marker.
	const candidates: Array<[string, string | undefined]> = [
		[full, status],
		[short, status],
		[full, undefined],
		[short, undefined],
	];
	for (const [title, label] of candidates) {
		const fixed = 6 + visibleWidth(title) + (label === undefined ? 0 : visibleWidth(label) + 2);
		const fill = width - fixed;
		if (fill < 1) continue;
		const right = label === undefined ? border(`${"─".repeat(fill)}─╮`) : `${border(`${"─".repeat(fill)} `)}${label}${border(" ─╮")}`;
		return `${border("╭─ ")}${theme.fg(color, theme.bold(title))}${border(" ")}${right}`;
	}
	return border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
}

function statusLabel(view: UserShellView, theme: Theme, elapsedMs: number | undefined): string {
	if (view.status === "running") {
		return theme.fg("muted", `Running… ${elapsedMs === undefined ? "" : runningTime(elapsedMs)}`.trimEnd());
	}
	const duration = elapsedMs === undefined ? "" : theme.fg("muted", ` · ${finishedTime(elapsedMs)}`);
	if (view.status === "cancelled") return theme.fg("warning", "cancelled") + duration;
	if (view.status === "error") return theme.fg("error", `exit ${view.exitCode ?? "?"}`) + duration;
	// pi completes a command that threw with no exit code; there is nothing to report but the end.
	return theme.fg("muted", view.exitCode === undefined ? "done" : `exit ${view.exitCode}`) + duration;
}

/** Whole seconds while running, so the label changes once a second. */
function runningTime(ms: number): string {
	return ms < 1_000 ? "0s" : formatDuration(ms);
}

function finishedTime(ms: number): string {
	return ms < 60_000 ? formatElapsed(ms) : formatDuration(ms);
}

function buildBody(view: UserShellView, width: number, theme: Theme, expandKey: string | undefined, fold?: ShellFold): Body {
	const color = colorOf(view);
	const border = (text: string) => theme.fg(color, text);
	const inner = width - 4;
	const row = (content: string): string => {
		const clipped = truncateToWidth(content, inner, "");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		return `${border("│")} ${clipped}${pad} ${border("│")}`;
	};

	const command: string[] = [];
	for (const line of commandLines(view.command)) command.push(...wrap(line, inner));
	const preview = outputPreview(view);
	// Nothing to fold: a one-row command without output already is three rows.
	const foldable = command.length > 1 || preview.total > 0;

	if (fold === "folded" && foldable) {
		const first = command[0] ?? "";
		const shown = command.length > 1 ? `${truncateToWidth(first, Math.max(0, inner - 2), "")} …` : first;
		const note = theme.fg(
			"muted",
			preview.total > 0 ? `… ${preview.total} ${preview.total === 1 ? "line" : "lines"} · click to show` : "… click to show",
		);
		return { rows: [row(theme.fg(color, theme.bold(shown)))], bottom: frameBottom(view, [note], width, theme), foldable };
	}

	const rows = command.map((part) => row(theme.fg(color, theme.bold(part))));
	let visual: string[] = [];
	for (const line of preview.lines) visual.push(...wrap(line, inner));
	// Like pi, the collapsed preview is also capped in screen rows, keeping the newest.
	if (!view.expanded && visual.length > PREVIEW_LINES) visual = visual.slice(-PREVIEW_LINES);
	for (const line of visual) rows.push(row(theme.fg("muted", line)));

	const open = fold === "open" && foldable;
	return { rows, bottom: buildBottom(view, preview, width, theme, expandKey, open), foldable };
}

function buildBottom(
	view: UserShellView,
	preview: OutputPreview,
	width: number,
	theme: Theme,
	expandKey: string | undefined,
	open: boolean,
): string {
	const notes: string[] = [];
	if (preview.hidden > 0) {
		const hint = expandKey ? ` · ${expandKey} to expand` : "";
		notes.push(theme.fg("muted", `… ${preview.hidden} more ${preview.hidden === 1 ? "line" : "lines"}${hint}`));
	} else if (view.expanded && preview.collapsible && expandKey) {
		notes.push(theme.fg("dim", `${expandKey} to collapse`));
	}
	if (view.truncated || preview.truncated) {
		notes.push(theme.fg("warning", view.fullOutputPath ? `truncated · full output: ${view.fullOutputPath}` : "output truncated"));
	}
	// Opened by a click (or Ctrl+O) under a user message: the click folds it back.
	if (open) notes.push(theme.fg("dim", "click to hide"));
	return frameBottom(view, notes, width, theme);
}

/** `╰─ notes ─…─╯`, clipped from the right; a plain border when nothing fits. */
function frameBottom(view: UserShellView, notes: readonly string[], width: number, theme: Theme): string {
	const border = (text: string) => theme.fg(colorOf(view), text);
	// `╰─ ` note ` ` + at least one `─` + `╯`.
	const budget = width - 6;
	if (notes.length === 0 || budget < 3) return border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	const note = truncateToWidth(notes.join(theme.fg("muted", " · ")), budget, "…");
	const fill = Math.max(1, width - 5 - visibleWidth(note));
	return `${border("╰─ ")}${note}${border(` ${"─".repeat(fill)}╯`)}`;
}

interface OutputPreview {
	/** Logical lines to show, oldest first. */
	lines: string[];
	/** Logical lines left out of the collapsed preview. */
	hidden: number;
	/** Every logical line there is to show, trailing blank lines dropped. */
	total: number;
	/** More lines than the collapsed preview holds, so Ctrl+O changes something. */
	collapsible: boolean;
	/** The output kept for the model was cut (pi's context limit). */
	truncated: boolean;
}

function outputPreview(view: UserShellView): OutputPreview {
	// The same limits pi applies before display, matching what the model receives.
	const context = truncateTail(view.outputLines.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const available = context.content ? context.content.split("\n").map(clean) : [];
	// A trailing newline would draw an empty row inside the box.
	while (available.length > 0 && available[available.length - 1]!.trim() === "") available.pop();
	const lines = view.expanded ? available : available.slice(-PREVIEW_LINES);
	return {
		lines,
		hidden: available.length - lines.length,
		total: available.length,
		collapsible: available.length > PREVIEW_LINES,
		truncated: context.truncated,
	};
}

function commandLines(command: string): string[] {
	const lines = command.replace(/\r\n?/g, "\n").split("\n").map(clean);
	while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}

/** Tabs as pi's Text draws them; other control characters would move the cursor. */
function clean(line: string): string {
	// eslint-disable-next-line no-control-regex
	return line.replace(/\t/g, "   ").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function wrap(line: string, width: number): string[] {
	if (line === "") return [""];
	const parts = wrapTextWithAnsi(line, width);
	return parts.length > 0 ? parts : [""];
}

/** Every match in the tree; a match listed in a container's `children` remembers that container. */
function collect(root: unknown, match: (value: unknown) => boolean): any[] {
	const out: any[] = [];
	const stack: Array<[unknown, Container | undefined]> = [[root, undefined]];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const [value, parent] = stack.pop()!;
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		const candidate = value as any;
		if (match(candidate)) {
			out.push(candidate);
			if (parent) parents.set(candidate, parent);
			continue;
		}
		if (Array.isArray(candidate.children)) {
			for (const child of candidate.children) stack.push([child, candidate as Container]);
		}
		if (candidate.child) stack.push([candidate.child, undefined]);
	}
	return out;
}
