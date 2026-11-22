import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

import type { BetterTuiConfig } from "./config.js";
import { argsOf, formatElapsed, sanitizeText } from "./format.js";
import { clickSegment, paintSegment } from "./fold-view.js";
import { ActivityTimeline, groupAction, groupActive, groupCounts, groupDuration, groupFailed, groupInterrupted, groupSummary, type Segment, type ToolGroup, type ToolRow } from "./timeline.js";
import { childLine, commandLines, memberDetailLines, runningBlock, runningStatus, showsRunningBlock } from "./tool-lines.js";
import {
	TOOL_LABELS,
	callDetail,
	isFailed,
	isInterrupted,
	isShellTool,
	resultLines,
	skillReadName,
	summarizeResult,
} from "./tool-summary.js";
import { skillHeader } from "./skill.js";

/** Text before a row's marker: none, the marker is the gutter's column 0. */
const MARKER_PAD = "";
/** Detail column of a standalone running command (fold-more.md §5.8). */
const SINGLE_DETAIL_RAIL = "     ";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<RenderResult>[0];

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

export interface ToolRenderDeps {
	timeline: ActivityTimeline;
	getConfig: () => BetterTuiConfig;
	getTheme: () => Theme;
}

interface RowViewOptions {
	timeline: ActivityTimeline;
	toolCallId: string;
	row: ToolRow;
	getConfig: () => BetterTuiConfig;
	getTheme: () => Theme;
	cwd: string;
	contextExpanded: boolean;
	invalidate: () => void;
}

export class ToolRowView implements Component {
	private timeline: ActivityTimeline;
	private toolCallId: string;
	private row: ToolRow;
	private getConfig: () => BetterTuiConfig;
	private getTheme: () => Theme;
	private cwd: string;
	private contextExpanded: boolean;
	private invalidateSelf: () => void;
	/** Line → item of the last fold host render, for clicks. */
	private foldTargets: string[] = [];

	constructor(options: RowViewOptions) {
		this.timeline = options.timeline;
		this.toolCallId = options.toolCallId;
		this.row = options.row;
		this.getConfig = options.getConfig;
		this.getTheme = options.getTheme;
		this.cwd = options.cwd;
		this.contextExpanded = options.contextExpanded;
		this.invalidateSelf = options.invalidate;
	}

	update(options: Omit<RowViewOptions, "timeline" | "toolCallId" | "row">): void {
		this.getConfig = options.getConfig;
		this.getTheme = options.getTheme;
		this.cwd = options.cwd;
		this.contextExpanded = options.contextExpanded;
		this.invalidateSelf = options.invalidate;
	}

	/** A session seed may replace the row object after the component was built. */
	private currentRow(): ToolRow {
		return this.timeline.row(this.toolCallId) ?? this.row;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.getTheme();
		const config = this.getConfig();

		// Fold (fold-more.md §5.6): decided on every render, so a segment crossing the threshold
		// or a late seed changes what this row draws without pi calling renderCall again.
		const role = this.timeline.foldRole(this.toolCallId);
		if (role.kind === "hidden") return [];
		if (role.kind === "host") return this.renderHost(role.segment, width, theme, config);

		const row = this.currentRow();
		const group = row.group;
		// Only the first member draws a group; the others stay empty even if pi kept their view.
		if (group && group.members[0] !== row) return [];
		const expanded = group ? group.expanded || this.contextExpanded : row.expanded || this.contextExpanded;
		// Markers sit in column 0 of the shared gutter (DESIGN.md §2); pi's outputPad is not used here.
		const pad = MARKER_PAD;

		if (group && group.members.length > 1) {
			return this.renderGroup(group, width, pad, theme, expanded);
		}
		return this.renderSingle(row, width, pad, theme, config, expanded);
	}

	handleMouse(event: { type?: string; button?: string; y?: number }): { handled: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left" || typeof event.y !== "number") return undefined;
		const role = this.timeline.foldRole(this.toolCallId);
		if (role.kind === "hidden") return undefined;
		if (role.kind === "host") {
			if (!clickSegment(this.timeline, role.segment, this.foldTargets, event.y)) return undefined;
			this.invalidateSelf();
			return { handled: true };
		}
		if (event.y !== 0) return undefined;
		const row = this.currentRow();
		const group = row.group;
		if (group && group.members.length > 1) this.timeline.toggleGroup(group);
		else this.timeline.toggleRow(row);
		this.invalidateSelf();
		return { handled: true };
	}

	invalidate(): void {
		// Rendering is derived from the live timeline; nothing is cached here.
	}

	private renderHost(segment: Segment, width: number, theme: Theme, config: BetterTuiConfig): string[] {
		const paint = paintSegment(segment, width, {
			timeline: this.timeline,
			config,
			theme,
			cwd: this.cwd,
			expanded: this.contextExpanded,
		});
		this.foldTargets = paint.targets;
		return paint.lines;
	}

	private renderGroup(
		group: ToolGroup,
		width: number,
		pad: string,
		theme: Theme,
		expanded: boolean,
	): string[] {
		const counts = groupCounts(group);
		const failed = groupFailed(group);
		const active = groupActive(group);
		// A process line, not an event (DESIGN.md §2.1): column 0 stays blank and the line is dim;
		// running and done differ by tense (Exploring / Explored). Only a failure gets a marker.
		const marker = failed > 0
			? theme.fg(failed === counts.calls ? "error" : "warning", failed === counts.calls ? "×" : "!")
			: " ";
		const action = groupAction(group);
		const summary = groupSummary(group) || `${counts.calls} tools`;
		const duration = groupDuration(group);
		const failure = failed > 0 ? theme.fg("error", ` · ${failed} failed`) : "";
		// An interrupt is a count on the process line, never a marker (DESIGN.md §9).
		const stopped = groupInterrupted(group);
		const interrupted = stopped > 0 ? theme.fg("warning", ` · ${stopped} interrupted`) : "";
		const time = duration >= 500 ? theme.fg("dim", ` · ${formatElapsed(duration)}`) : "";
		const disclosure = theme.fg("dim", expanded || active || failed > 0 ? " ▾" : " ▸");
		const header = `${pad}${marker} ${theme.fg("dim", `${action} ${summary}`)}${failure}${interrupted}${time}${disclosure}`;

		const lines = [header];
		const selected = expanded
			? group.members
			: failed > 0
				? group.members.filter((member) => isFailed(member.result)).slice(-2)
				: active
					? group.members.slice(-2)
					: [];

		for (let index = 0; index < selected.length; index++) {
			const member = selected[index]!;
			const isLast = index === selected.length - 1;
			lines.push(`${pad}${childLine(member, isLast ? "└" : "├", width, theme, this.cwd)}`);
			if (expanded) {
				lines.push(...this.renderMemberDetail(member, width, pad, isLast, theme, 8));
			}
		}

		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	private renderSingle(
		row: ToolRow,
		width: number,
		pad: string,
		theme: Theme,
		config: BetterTuiConfig,
		expanded: boolean,
	): string[] {
		const running = row.endedAt === undefined;
		// With fold on, a running command is the same fixed-height block a segment host draws
		// (fold-more.md §5.8); with fold off the preview stays as it was.
		const block = this.timeline.foldEnabled && isShellTool(row.name) && running && !expanded;
		const lines = [this.renderSingleHeader(row, width, pad, theme, expanded, block)];
		if (expanded) {
			if (isShellTool(row.name)) lines.push(...commandLines(row, width, `${pad}  `, theme));
			lines.push(...this.renderMemberDetail(row, width, pad, true, theme, 14, true));
		} else if (isFailed(row.result)) {
			// An interrupted call shows no detail: its last line only repeats `interrupted`.
			lines.push(...this.renderMemberDetail(row, width, pad, true, theme, 2, true));
		} else if (block) {
			// Under one second the command stays its header line (fold-more.md §5.8).
			if (showsRunningBlock(row)) {
				lines.push(...runningBlock(row, width, theme, `${pad}${SINGLE_DETAIL_RAIL}`, config.tools.shellPreviewLines));
			}
		} else if (isShellTool(row.name) && running && config.tools.shellPreviewLines > 0) {
			const preview = resultLines({ content: [{ type: "text", text: row.partialText }], isError: false }, config.tools.shellPreviewLines, "tail");
			for (let index = 0; index < preview.length; index++) {
				const rail = index === 0 ? "  └ " : "    ";
				lines.push(`${pad}${theme.fg("dim", rail)}${theme.fg("toolOutput", preview[index]!)}`);
			}
		}
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	private renderSingleHeader(row: ToolRow, width: number, pad: string, theme: Theme, expanded: boolean, block = false): string {
		const skill = skillReadName(row.name, row.args);
		if (skill !== undefined) return this.renderSkillHeader(row, skill, pad, theme, expanded);
		const label = TOOL_LABELS[row.name] ?? row.name;
		const detail = sanitizeText(callDetail(row.name, row.args, this.cwd));
		const labelText = theme.fg("toolTitle", theme.bold(label));
		const detailText = detail ? ` ${theme.fg("muted", `(${detail})`)}` : "";
		if (isInterrupted(row.result)) {
			// Same `●` as every single row; warning says it did not finish, without calling it a
			// failure, in the color of `✻ Interrupted` below (DESIGN.md §9).
			const time = isShellTool(row.name) || this.rowDuration(row) >= 1_000
				? theme.fg("dim", ` · ${formatElapsed(this.rowDuration(row))}`)
				: "";
			return `${pad}${theme.fg("warning", "●")} ${labelText}${detailText}${theme.fg("warning", " · interrupted")}${time}`;
		}
		const marker = row.result?.isError
			? theme.fg("error", "×")
			: row.endedAt === undefined
				? theme.fg("accent", "●")
				: theme.fg("success", "●");
		const summary = block ? runningStatus(row) : this.singleSummary(row);
		const summaryText = summary
			? theme.fg(row.result?.isError ? "error" : "dim", ` · ${summary}`)
			: "";
		return `${pad}${marker} ${labelText}${detailText}${summaryText}`;
	}

	/** A read of `…/<name>/SKILL.md`, drawn like a `/skill:name` invocation. */
	private renderSkillHeader(row: ToolRow, name: string, pad: string, theme: Theme, expanded: boolean): string {
		if (row.result?.isError) {
			const label = theme.fg("customMessageLabel", theme.bold("[Skill]"));
			// The error text itself follows on the detail lines below the header.
			const summary = theme.fg("error", " · Failed");
			return `${pad}${theme.fg("error", "×")} ${label} ${theme.fg("muted", `(${name})`)}${summary}`;
		}
		return `${pad}${skillHeader(theme, name, expanded)}`;
	}

	private singleSummary(row: ToolRow): string {
		if (row.result) {
			const base = summarizeResult(row.name, row.result, row.args);
			const duration = this.rowDuration(row);
			const time = duration >= 1_000 || isShellTool(row.name) ? ` · ${formatElapsed(duration)}` : "";
			return base + time;
		}
		if (row.endedAt !== undefined) return "Done";
		return isShellTool(row.name) ? `Running… · ${formatElapsed(this.rowDuration(row))}` : "Running…";
	}

	private rowDuration(row: ToolRow): number {
		return Math.max(0, (row.endedAt ?? Date.now()) - row.startedAt);
	}

	private renderMemberDetail(
		row: ToolRow,
		width: number,
		pad: string,
		isLast: boolean,
		_theme: Theme,
		maxLines: number,
		standalone = false,
	): string[] {
		const rail = standalone ? "  " : isLast ? "     " : "  │  ";
		return memberDetailLines(row, width, _theme, `${pad}${rail}`, maxLines);
	}
}

function ensureRow(
	deps: ToolRenderDeps,
	toolName: string,
	args: unknown,
	context: RenderContext,
): ToolRow {
	const existing = deps.timeline.row(context.toolCallId);
	if (existing) {
		existing.args = argsOf(args);
		existing.invalidate = context.invalidate;
		deps.timeline.detachSkillRead(context.toolCallId);
		return existing;
	}
	const row = deps.timeline.begin(
		context.toolCallId,
		toolName,
		args,
		Date.now(),
		deps.getConfig().tools.groupReadOnly,
	);
	row.args = argsOf(args);
	row.invalidate = context.invalidate;
	return row;
}

export function createToolRenderers(
	toolName: string,
	_native: ToolRenderers | undefined,
	deps: ToolRenderDeps,
): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(args, _theme, context) {
			const row = ensureRow(deps, toolName, args, context);
			if (context.executionStarted && row.endedAt === undefined) {
				row.startedAt ||= Date.now();
				// Normally set by tool_execution_start already; a row rebuilt after it still needs it.
				row.execStartedAt ??= Date.now();
			}
			// Ctrl+O reaches tool rows only; thinking hosts read it from here (fold-more.md §5.11).
			deps.timeline.globalExpanded = context.expanded;
			if (row.group && row.group.members[0] !== row) return EMPTY_COMPONENT;

			const previous = context.lastComponent;
			const view = previous instanceof ToolRowView
				? previous
				: new ToolRowView({
						timeline: deps.timeline,
						toolCallId: context.toolCallId,
						row,
						getConfig: deps.getConfig,
						getTheme: deps.getTheme,
						cwd: context.cwd,
						contextExpanded: context.expanded,
						invalidate: context.invalidate,
					});
			view.update({
				getConfig: deps.getConfig,
				getTheme: deps.getTheme,
				cwd: context.cwd,
				contextExpanded: context.expanded,
				invalidate: context.invalidate,
			});
			return view;
		},
		renderResult(result, options, _theme, context) {
			const row = ensureRow(deps, toolName, context.args, context);
			row.invalidate = context.invalidate;
			// pi also hands running output to renderResult; it is a preview, not the end of the call.
			if (options.isPartial && row.endedAt === undefined) {
				deps.timeline.update(context.toolCallId, result);
				deps.timeline.refreshHost(row.id);
				return EMPTY_COMPONENT;
			}
			// A redraw (for example Ctrl+O) must not turn a restored result into a
			// new one: keep the persisted end timestamp when the row already has it.
			const endedAt = row.endedAt ?? Date.now();
			deps.timeline.setResult(context.toolCallId, {
				content: result.content,
				details: result.details,
				// pi keeps the error flag on the context, not on the result object.
				isError: context.isError === true || (result as { isError?: unknown }).isError === true,
				durationMs: context.durationMs,
			}, endedAt);
			row.invalidate = context.invalidate;
			if (row.group && row.group.members[0] !== row) deps.timeline.refresh(row.id);
			// The host of a fold segment draws this result; it never invalidates this row back.
			deps.timeline.refreshHost(row.id);
			return EMPTY_COMPONENT;
		},
	};
}
