/**
 * Line builders shared by tool rows, read-only groups and fold segments. Each returns finished
 * lines (truncated to `width`); callers only decide where they go.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { formatDuration, sanitizeText, str } from "./format.js";
import type { ToolRow } from "./timeline.js";
import {
	TOOL_LABELS,
	callDetail,
	isFailed,
	isInterrupted,
	isShellTool,
	resultLineTotal,
	resultLines,
	resultText,
	shellCommandLines,
	summarizeResult,
} from "./tool-summary.js";

export const MAX_EXPANDED_COMMAND_LINES = 12;

/** One child row under a group or segment: rail in column 2, the tool from column 4. */
export function childLine(member: ToolRow, rail: "├" | "└", width: number, theme: Theme, cwd: string, status?: string): string {
	const railText = theme.fg("dim", `  ${rail} `);
	const label = TOOL_LABELS[member.name] ?? member.name;
	const detail = sanitizeText(callDetail(member.name, member.args, cwd));
	const labelText = theme.fg("toolTitle", label);
	const detailText = detail ? ` ${theme.fg("muted", `(${detail})`)}` : "";
	const interrupted = isInterrupted(member.result);
	const summary = status ?? (interrupted
		? "interrupted"
		: member.result?.isError
			? "failed"
			: member.endedAt === undefined
				? "running"
				: member.result
					? summarizeResult(member.name, member.result, member.args)
					: "Done");
	const color = interrupted ? "warning" : member.result?.isError ? "error" : "dim";
	const summaryText = summary ? ` ${theme.fg(color, `· ${summary}`)}` : "";
	return truncateToWidth(`${railText}${labelText}${detailText}${summaryText}`, width, "…");
}

/** Output or diff lines of a row, each behind `rail` (dim). */
export function memberDetailLines(row: ToolRow, width: number, theme: Theme, rail: string, maxLines: number): string[] {
	const source = detailSource(row);
	if (!source.text) return [];
	let lines = source.lines;
	const total = source.total;
	if (lines.length > maxLines) {
		lines = source.keep === "head" ? lines.slice(0, maxLines) : lines.slice(-maxLines);
	}
	const railText = theme.fg("dim", rail);
	// An interrupted command keeps its output's own color; only a failure turns it red.
	const failed = isFailed(row.result);
	const output = lines.map((line) => {
		const color = failed
			? "error"
			: row.name === "edit" && line.startsWith("+")
				? "success"
				: row.name === "edit" && line.startsWith("-")
					? "error"
					: "toolOutput";
		return `${railText}${theme.fg(color, line)}`;
	});
	const hidden = Math.max(0, total - lines.length);
	if (hidden > 0) {
		output.push(`${railText}${theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`)}`);
	}
	return output.map((line) => truncateToWidth(line, width, "…"));
}

export function detailSource(row: ToolRow): { text: string; lines: string[]; total: number; keep: "head" | "tail" } {
	if (row.name === "edit" && row.result) {
		const diff = (row.result.details as { diff?: unknown } | undefined)?.diff;
		if (typeof diff === "string") {
			const lines = sanitizeText(diff).split("\n").filter((line) => line.trim() !== "");
			return { text: diff, lines, total: lines.length, keep: "head" };
		}
	}
	const text = row.partialText || resultText(row.result);
	if (!text) return { text: "", lines: [], total: 0, keep: "tail" };
	const total = resultLineTotal(row.result ?? { content: [{ type: "text", text }], isError: false });
	const keep: "head" | "tail" = isShellTool(row.name) || row.result?.isError ? "tail" : "head";
	return { text, lines: resultLines(row.result ?? { content: [{ type: "text", text }], isError: false }, 1_000, keep), total, keep };
}

/** The full command, wrapped: `$ ` before the first line, continuation lines aligned under it. */
export function commandLines(row: ToolRow, width: number, indent: string, theme: Theme, max = MAX_EXPANDED_COMMAND_LINES): string[] {
	const source = shellCommandLines(row.args);
	if (source.length === 0) return [];
	const contentWidth = Math.max(1, width - visibleWidth(indent) - 2);
	const wrapped: string[] = [];
	for (const line of source) {
		const pieces = line ? wrapTextWithAnsi(line, contentWidth) : [""];
		wrapped.push(...pieces);
	}
	const shown = wrapped.slice(0, max);
	const output = shown.map((line, index) => {
		const prompt = index === 0 ? theme.fg("accent", "$ ") : "  ";
		return `${indent}${prompt}${theme.fg("text", line)}`;
	});
	const hidden = wrapped.length - shown.length;
	if (hidden > 0) {
		output.push(`${indent}${theme.fg("dim", `  … ${hidden} more command line${hidden === 1 ? "" : "s"}`)}`);
	}
	return output.map((line) => truncateToWidth(line, width, "…"));
}

/** `Running… 12s` for a command, `Running…` below one second (fold-more.md §5.8). */
export function runningStatus(row: ToolRow, now = Date.now()): string {
	const elapsed = Math.max(0, now - row.startedAt);
	return elapsed >= 1_000 ? `Running… ${formatDuration(elapsed)}` : "Running…";
}

/**
 * How long a command runs before its preview block opens (fold-more.md §5.8). A quick command
 * stays one line for its whole life, so a run of quick commands does not make the screen
 * stretch and shrink.
 */
export const RUNNING_BLOCK_DELAY_MS = 1_000;

/** Whether a running command has run long enough to show its fixed-height preview block. */
export function showsRunningBlock(row: ToolRow, now = Date.now()): boolean {
	if (row.endedAt !== undefined || row.execStartedAt === undefined) return false;
	return now - row.execStartedAt >= RUNNING_BLOCK_DELAY_MS;
}

/** Rows a running command block takes below its header: script lines only with a description. */
export function runningBlockHeight(row: ToolRow, previewLines: number): number {
	return (hasDescription(row) ? 2 : 0) + Math.max(0, previewLines);
}

function hasDescription(row: ToolRow): boolean {
	return str(row.args.description).trim().length > 0;
}

/**
 * The fixed-height body of a running command (fold-more.md §5.8): the first two script lines
 * when the header shows a description instead of the command, then the last `previewLines`
 * output lines. Missing lines are padded with the bare rail so the block never changes height
 * while output arrives.
 */
export function runningBlock(row: ToolRow, width: number, theme: Theme, rail: string, previewLines: number): string[] {
	const railText = theme.fg("dim", rail);
	const room = Math.max(1, width - visibleWidth(rail));
	const lines: string[] = [];
	if (hasDescription(row)) {
		const script = shellCommandLines(row.args);
		for (let index = 0; index < 2; index++) {
			const line = script[index];
			if (line === undefined) {
				lines.push(railText);
				continue;
			}
			const more = index === 1 && script.length > 2 ? " …" : "";
			const prompt = index === 0 ? theme.fg("accent", "$ ") : "  ";
			lines.push(`${railText}${prompt}${theme.fg("text", truncateToWidth(line + more, Math.max(1, room - 2), "…"))}`);
		}
	}
	const count = Math.max(0, previewLines);
	if (count > 0) {
		const output = resultLines({ content: [{ type: "text", text: row.partialText }], isError: false }, count, "tail");
		for (let index = 0; index < count; index++) {
			const line = output[index];
			lines.push(line === undefined ? railText : `${railText}${theme.fg("toolOutput", line)}`);
		}
	}
	return lines.map((line) => truncateToWidth(line, width, "…"));
}
