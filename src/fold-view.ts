/**
 * What the host of a folded segment draws (fold-more.md §5.4–§5.8). While its run goes on, the
 * segment is a compact list that only grows: one line per item, the live part (a streaming
 * thought's tail, a long-running command's preview) under the last items. Once the run settles
 * it collapses into one summary line, which opens back into the same list. Tool rows and
 * thinking slots both host segments, so the drawing lives here and reads only the timeline.
 *
 * Columns follow DESIGN.md §2: marker 0, rail 2, child content 4, details 5.
 */
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";

import type { BetterTuiConfig } from "./config.js";
import { tailThinkingRows, thoughtLabel } from "./format.js";
import { summaryMarker, summaryText } from "./segment.js";
import { type ActivityTimeline, type Segment, type SegItem, type SegThinkingItem, thoughtDuration, type ToolRow } from "./timeline.js";
import { childLine, commandLines, memberDetailLines, runningBlock, runningStatus, showsRunningBlock } from "./tool-lines.js";
import { isFailed, isShellTool } from "./tool-summary.js";

/** Click target of the summary line; other lines carry the anchor of their item. */
export const SUMMARY_TARGET = "";

/** Detail lines of an expanded item. */
const TOOL_DETAIL_LINES = 8;
const COMMAND_DETAIL_LINES = 6;

export interface FoldPaintOptions {
	timeline: ActivityTimeline;
	config: BetterTuiConfig;
	theme: Theme;
	cwd: string;
	/** pi's Ctrl+O state as the host sees it. */
	expanded: boolean;
	now?: number;
}

export interface FoldPaint {
	lines: string[];
	/** Per line: SUMMARY_TARGET or the anchor of the item the line belongs to. */
	targets: string[];
}

const markdownCache = new WeakMap<SegThinkingItem, { text: string; palette: string; markdown: Markdown }>();

export function paintSegment(segment: Segment, width: number, options: FoldPaintOptions): FoldPaint {
	const { timeline, theme } = options;
	const now = options.now ?? Date.now();
	const lines: string[] = [];
	const targets: string[] = [];

	// While the run goes on the segment is its list, with no summary above it (§5.7); the list
	// only grows, so the screen never stretches and shrinks back.
	const list = !segment.collapsed || segment.expanded || options.expanded;
	if (segment.collapsed) {
		// A process line (DESIGN.md §2.1): no marker, dim from column 2; only a failure takes column 0.
		const stats = timeline.segmentStats(segment, now);
		const marker = summaryMarker(stats);
		const markerText = marker === " " ? " " : theme.fg(marker === "×" ? "error" : "warning", marker);
		const failure = stats.failed > 0 ? theme.fg("error", ` · ${stats.failed} failed`) : "";
		// An interrupt is said once by `✻ Interrupted`; here it is a count, with no marker (DESIGN.md §9).
		const interrupted = stats.interrupted > 0 ? theme.fg("warning", ` · ${stats.interrupted} interrupted`) : "";
		const disclosure = theme.fg("dim", list ? " ▾" : " ▸");
		lines.push(truncateToWidth(`${markerText} ${theme.fg("dim", summaryText(stats))}${failure}${interrupted}${disclosure}`, width, "…"));
		targets.push(SUMMARY_TARGET);
	}

	const exposed = list ? undefined : exposedFailures(segment, timeline);
	const shown = exposed ? exposed.items : segment.items;
	if (exposed && exposed.hidden > 0) {
		// The earlier failures that did not fit: one dim line above them; a click opens the list.
		lines.push(truncateToWidth(theme.fg("dim", `  ├ … ${exposed.hidden} more failed`), width, "…"));
		targets.push(SUMMARY_TARGET);
	}
	// Parallel commands: only the newest running one gets the full block (§5.7).
	const newestCommand = [...shown].reverse().find((item) => {
		const row = toolRow(timeline, item);
		return row !== undefined && isShellTool(row.name) && row.endedAt === undefined;
	});

	for (let index = 0; index < shown.length; index++) {
		const item = shown[index]!;
		// The rail is derived from the position on every render: the last item takes `└`, and it
		// turns into `├` as soon as another item is appended below it.
		const isLast = index === shown.length - 1;
		const block = item.kind === "thinking"
			? thinkingLines(item, segment, isLast, width, options, list)
			: toolLines(item.anchor, segment, isLast, item === newestCommand, width, options, now);
		for (const line of block) {
			lines.push(truncateToWidth(line, width, "…"));
			targets.push(item.anchor);
		}
	}
	return { lines, targets };
}

/** At most this many failed items stay visible under a collapsed summary. */
export const EXPOSED_FAILURES = 3;

/**
 * Collapsed with failures: every failed item stays visible as one line, up to EXPOSED_FAILURES
 * of the newest (§5.4). Each failure is its own anomaly, so the lines match the `N failed` count.
 */
function exposedFailures(segment: Segment, timeline: ActivityTimeline): { items: SegItem[]; hidden: number } {
	const failed = segment.items.filter((item) => item.kind === "tool" && isFailed(timeline.row(item.anchor)?.result));
	const items = failed.slice(-EXPOSED_FAILURES);
	return { items, hidden: failed.length - items.length };
}

function toolRow(timeline: ActivityTimeline, item: SegItem): ToolRow | undefined {
	return item.kind === "tool" ? timeline.row(item.anchor) : undefined;
}

function rails(isLast: boolean): { head: "├" | "└"; body: string; detail: string } {
	return isLast
		? { head: "└", body: "    ", detail: "     " }
		: { head: "├", body: "  │ ", detail: "  │  " };
}

function thinkingLines(
	item: SegThinkingItem,
	segment: Segment,
	isLast: boolean,
	width: number,
	options: FoldPaintOptions,
	expanded: boolean,
): string[] {
	const { theme, config, timeline } = options;
	const rail = rails(isLast);
	const style = (text: string) => theme.italic(theme.fg("thinkingText", text));
	if (item.streaming) {
		// The tail of the thought in column 4, fixed height; the summary already says "Thinking".
		// Wrapped rows (DESIGN.md §2.1). Column 2 holds the rail, so the "… " for hidden rows takes
		// two columns of the body; the wrap width leaves them out either way, and once it shows the
		// other rows step in by two to stay aligned with the first.
		const count = Math.max(1, config.thinking.lines);
		const room = Math.max(1, width - 4 - 2);
		const { rows, hidden } = tailThinkingRows(item.text, count, room);
		const output: string[] = [];
		for (let index = 0; index < count; index++) {
			const rawPrefix = index === 0 ? `  ${rail.head} ` : rail.body;
			const prefix = theme.fg("dim", rawPrefix);
			const row = rows[index];
			if (row === undefined) {
				output.push(rawPrefix.trim() ? prefix : "");
				continue;
			}
			const lead = hidden ? (index === 0 ? "… " : "  ") : "";
			output.push(`${prefix}${style(lead + row)}`);
		}
		return output;
	}
	// A finished thought is one short dim line, like the standalone thinking header; the thought
	// itself is in its details (a click, or Ctrl+T), so the list keeps room to breathe (§5.5).
	const output = [`${theme.fg("dim", `  ${rail.head} `)}${theme.fg("dim", thoughtLabel(thoughtDuration(item)))}`];
	if (expanded && (segment.expandedItems.has(item.anchor) || timeline.thinkingDetails)) {
		output.push(...thinkingDetail(item, width, rail.detail, theme));
	}
	return output;
}

function thinkingDetail(item: SegThinkingItem, width: number, rail: string, theme: Theme): string[] {
	const palette = [theme.fg("thinkingText", "x"), theme.italic("x")].join("|");
	let cached = markdownCache.get(item);
	if (!cached || cached.text !== item.text || cached.palette !== palette) {
		const markdown = new Markdown(item.text, 0, 0, getMarkdownTheme(), {
			color: (line: string) => theme.fg("thinkingText", line),
			italic: true,
		});
		cached = { text: item.text, palette, markdown };
		markdownCache.set(item, cached);
	}
	const railText = theme.fg("dim", rail);
	return cached.markdown.render(Math.max(1, width - rail.length)).map((line) => `${railText}${line}`);
}

function toolLines(
	anchor: string,
	segment: Segment,
	isLast: boolean,
	fullBlock: boolean,
	width: number,
	options: FoldPaintOptions,
	now: number,
): string[] {
	const { timeline, theme, cwd, config } = options;
	const rail = rails(isLast);
	const row = timeline.row(anchor);
	if (!row) return [`${theme.fg("dim", `  ${rail.head} `)}${theme.fg("dim", "running")}`];
	const running = row.endedAt === undefined;
	const shell = isShellTool(row.name);
	const status = running && shell ? runningStatus(row, now) : undefined;
	const output = [childLine(row, rail.head, width, theme, cwd, status)];
	// A command shorter than RUNNING_BLOCK_DELAY_MS stays this one line (§5.8).
	if (fullBlock && showsRunningBlock(row, now)) {
		output.push(...runningBlock(row, width, theme, rail.detail, config.tools.shellPreviewLines));
	} else if (segment.expandedItems.has(anchor)) {
		// Drawn tool items are the list or the failures exposed under a collapsed summary; both open
		// in place (a failure without opening the whole list).
		const detailRail = theme.fg("dim", rail.detail);
		if (shell) output.push(...commandLines(row, width, detailRail, theme, COMMAND_DETAIL_LINES));
		output.push(...memberDetailLines(row, width, theme, rail.detail, TOOL_DETAIL_LINES));
	}
	return output;
}

/**
 * A click on the host at line `y`. The summary (and the `… N more failed` line) opens and closes
 * the list; an item's line — in the list, or a failure exposed under the closed summary — opens
 * and closes that item's details in place.
 */
export function clickSegment(timeline: ActivityTimeline, segment: Segment, targets: readonly string[], y: number): boolean {
	const target = targets[y];
	if (target === undefined) return false;
	if (target === SUMMARY_TARGET) timeline.toggleSegment(segment);
	else timeline.toggleSegmentItem(segment, target);
	return true;
}
