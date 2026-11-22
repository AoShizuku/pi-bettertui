import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const str = (value: unknown): string => (typeof value === "string" ? value : "");

export const argsOf = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function countLines(text: string): number {
	const trimmed = text.trim();
	if (!trimmed || trimmed === "(no output)") return 0;
	return trimmed.split("\n").length;
}

export function firstLine(text: string): string {
	const lines = sanitizeText(text).replace(/\r\n?/g, "\n").trim().split("\n");
	const head = lines[0] ?? "";
	return lines.length > 1 ? `${head} … (+${lines.length - 1} lines)` : head;
}

export function sanitizeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			// Progress bars use carriage returns; keep the final frame only.
			const frames = line.replace(/\r+$/, "");
			return frames.slice(frames.lastIndexOf("\r") + 1);
		})
		.join("\n")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

export function displayPath(path: string, cwd: string, home = homedir()): string {
	if (!path || !isAbsolute(path)) return path;
	const inCwd = inside(cwd, path);
	if (inCwd !== undefined) return inCwd;
	const inHome = inside(home, path);
	return inHome === undefined ? path : inHome ? `~/${inHome}` : "~";
}

function inside(base: string, path: string): string | undefined {
	const result = relative(base, path);
	return result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result)
		? result.split(sep).join("/")
		: undefined;
}

export function lineRange(args: Record<string, unknown>): string {
	const offset = args.offset;
	const limit = args.limit;
	if (typeof offset !== "number" && typeof limit !== "number") return "";
	const start = typeof offset === "number" ? offset : 1;
	return typeof limit === "number" ? `:${start}-${start + limit - 1}` : `:${start}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1_000) return "<1s";
	const seconds = Math.floor(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * The header of a finished thought: `Thought for 18s`, or plain `Thought` under a second or
 * without a known duration. The standalone thinking block and the fold list share it.
 */
/** `Thought for 0.8s` / `Thought for 12.4s` under a minute, `Thought for 2m 5s` beyond; `Thought` when unknown. */
export function thoughtLabel(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 100) return "Thought";
	if (ms < 60_000) return `Thought for ${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
	return `Thought for ${formatDuration(ms)}`;
}

export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0.0s";
	if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
	return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * Clip `text` to `budget` visible columns by removing its middle, so both the
 * program and the end of a long command stay readable. Grapheme-safe.
 */
export function clipMiddle(text: string, budget: number): string {
	if (budget <= 0) return "";
	if (visibleWidth(text) <= budget) return text;
	if (budget === 1) return "…";
	const parts = Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
	const room = budget - 1;
	const headBudget = Math.ceil(room * 0.6);
	const tailBudget = room - headBudget;
	let head = "";
	let headWidth = 0;
	let start = 0;
	for (; start < parts.length; start++) {
		const width = visibleWidth(parts[start]!);
		if (headWidth + width > headBudget) break;
		head += parts[start];
		headWidth += width;
	}
	let tail = "";
	let tailWidth = 0;
	for (let end = parts.length - 1; end >= start; end--) {
		const width = visibleWidth(parts[end]!);
		if (tailWidth + width > tailBudget + (headBudget - headWidth)) break;
		tail = parts[end] + tail;
		tailWidth += width;
	}
	return `${head.trimEnd()}…${tail.trimStart()}`;
}

/** Inside a paragraph longer than the tail window, the wrap start moves in steps of this many characters. */
const THINKING_TAIL_STEP = 4_096;

/**
 * The newest `count` screen rows of a thought, word-wrapped at `width` (DESIGN.md §2.1).
 *
 * Rows that are full do not change as text streams in: only the last one grows, then the block
 * moves up a row. Only the tail is wrapped, and it starts at a paragraph start (inside a very long
 * paragraph, at a fixed step from that start), never at "the last N characters": a start that moved
 * with every token would move every line break after it, and the rows would slide again.
 */
export function tailThinkingRows(
	text: string,
	count: number,
	width: number,
): { rows: string[]; hidden: boolean } {
	const start = thinkingTailStart(text, Math.max(2_000, count * width * 2));
	const rows = sanitizeText(text.slice(start))
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.flatMap((paragraph) => wrapTextWithAnsi(paragraph, Math.max(1, width)));
	return { rows: rows.slice(-count), hidden: start > 0 || rows.length > count };
}

/** Where the wrapped tail starts: at most `window` characters from the end, on a stable boundary. */
function thinkingTailStart(text: string, window: number): number {
	const cut = text.length - window;
	if (cut <= 0) return 0;
	const paragraph = text.lastIndexOf("\n", cut) + 1;
	const start = paragraph + Math.floor((cut - paragraph) / THINKING_TAIL_STEP) * THINKING_TAIL_STEP;
	// Never begin on the second half of a surrogate pair.
	return /[\uDC00-\uDFFF]/.test(text[start] ?? "") ? start + 1 : start;
}

export function stripNotice(text: string): string {
	return text.replace(/\n+$/, "");
}
