import { clipMiddle, countLines, displayPath, lineRange, plural, sanitizeText, str } from "./format.js";
import type { ToolResultSnapshot } from "./types.js";

export const TOOL_LABELS: Record<string, string> = {
	read: "Read",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "LS",
};

export const MANAGED_TOOL_NAMES = new Set(Object.keys(TOOL_LABELS));
export const MERGEABLE_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

export function isManagedTool(name: string): boolean {
	return MANAGED_TOOL_NAMES.has(name);
}

export function isMergeableTool(name: string): boolean {
	return MERGEABLE_TOOL_NAMES.has(name);
}

export function isShellTool(name: string): boolean {
	return name === "bash" || name === "powershell";
}

/**
 * The skill name when a read loads a skill (`…/<name>/SKILL.md`), else undefined.
 * Such reads get their own `● [Skill] (name)` row instead of joining a read group.
 */
export function skillReadName(name: string, args: Record<string, unknown>): string | undefined {
	if (name !== "read") return undefined;
	const parts = str(args.file_path ?? args.path).replace(/\\/g, "/").split("/").filter(Boolean);
	if (parts.at(-1) !== "SKILL.md") return undefined;
	return parts.at(-2) ?? "SKILL.md";
}

export function resultText(result: ToolResultSnapshot | undefined): string {
	if (!result) return "";
	return sanitizeText(
		result.content
			.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
			.join("\n"),
	).trim();
}

/**
 * pi's texts for a call cut short by an interrupt: `Operation aborted` (the agent loop, the built-in
 * tools, and the interactive mode for calls whose arguments were still streaming), `Command aborted`
 * (appended under a command's output), a bare `aborted`, and `Aborted after N retry attempts`.
 */
const INTERRUPT_LINE = /^(?:(?:operation|command|request)(?: was)? )?aborted(?: after \d+ retry attempts?)?\.?$/i;

/**
 * Whether an error result only says the call was interrupted (DESIGN.md §9): the user stopped the
 * run, the tool did not fail. Only the last line counts, so a command's own output above
 * pi's `Command aborted` does not matter.
 */
export function isInterrupted(result: ToolResultSnapshot | undefined): boolean {
	if (!result?.isError) return false;
	const lines = resultText(result).split("\n");
	const last = lines[lines.length - 1]?.trim() ?? "";
	return INTERRUPT_LINE.test(last);
}

/** An error result that is a real failure, not an interrupt. */
export function isFailed(result: ToolResultSnapshot | undefined): boolean {
	return result?.isError === true && !isInterrupted(result);
}

export function resultImageCount(result: ToolResultSnapshot | undefined): number {
	return result?.content.filter((block) => block.type === "image").length ?? 0;
}

function details(result: ToolResultSnapshot | undefined): Record<string, unknown> {
	const value = result?.details;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function truncationTotal(result: ToolResultSnapshot | undefined): number | undefined {
	const value = details(result).truncation;
	if (typeof value !== "object" || value === null) return undefined;
	const totalLines = (value as { totalLines?: unknown }).totalLines;
	return typeof totalLines === "number" && Number.isSafeInteger(totalLines) ? totalLines : undefined;
}

function truncated(result: ToolResultSnapshot | undefined): boolean {
	const value = details(result).truncation;
	return typeof value === "object" && value !== null && (value as { truncated?: unknown }).truncated === true;
}

export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export function callDetail(name: string, args: Record<string, unknown>, cwd: string): string {
	const path = displayPath(str(args.file_path ?? args.path), cwd);
	switch (name) {
		case "read":
			return path + lineRange(args);
		case "edit":
		case "write":
			return path;
		case "bash":
		case "powershell":
			return shellDetail(args);
		case "grep": {
			const pattern = str(args.pattern);
			return pattern ? `/${pattern}/${path ? ` in ${path}` : ""}` : path;
		}
		case "find": {
			const pattern = str(args.pattern);
			return pattern && path ? `${pattern} in ${path}` : pattern || path;
		}
		case "ls":
			return path || ".";
		default:
			return "";
	}
}

/** Widest a raw command may get in a row header; the rest is cut from the middle. */
export const SHELL_COMMAND_MAX_WIDTH = 72;

/** The model's description when it gave one, otherwise a width-capped command. */
export function shellDetail(args: Record<string, unknown>): string {
	const description = sanitizeText(str(args.description)).replace(/\s+/g, " ").trim();
	if (description) return description;
	return shellCommandSummary(str(args.command));
}

export function shellCommandSummary(command: string, maxWidth = SHELL_COMMAND_MAX_WIDTH): string {
	const lines = sanitizeText(command).replace(/\r\n?/g, "\n").trim().split("\n");
	const head = clipMiddle((lines[0] ?? "").trim(), maxWidth);
	return lines.length > 1 ? `${head} … (+${lines.length - 1} lines)` : head;
}

/** Full command split into display lines, for the expanded view. */
export function shellCommandLines(args: Record<string, unknown>): string[] {
	const command = sanitizeText(str(args.command)).replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
	return command ? command.split("\n").map((line) => line.trimEnd()) : [];
}

/** Stable identity for "how many distinct files did this group touch?". */
export function targetKey(name: string, args: Record<string, unknown>, fallback: string): string {
	if (name === "read" || name === "edit" || name === "write" || name === "ls") {
		const path = str(args.file_path ?? args.path);
		return path || fallback;
	}
	if (name === "grep" || name === "find") {
		const pattern = str(args.pattern);
		const path = str(args.path);
		return `${pattern}\u0000${path}` || fallback;
	}
	return fallback;
}

export function summarizeResult(name: string, result: ToolResultSnapshot, args: Record<string, unknown>): string {
	const text = resultText(result);
	switch (name) {
		case "read": {
			if (resultImageCount(result) > 0) return "image";
			const lines = truncationTotal(result) ?? countLines(text);
			return plural(lines, "line") + (truncated(result) ? " · truncated" : "");
		}
		case "bash":
		case "powershell": {
			const lines = truncationTotal(result) ?? countLines(text);
			const exit = result.isError ? /Command exited with code (\d+)/.exec(text)?.[1] : undefined;
			const head = result.isError ? (exit ? `Failed (exit ${exit})` : "Failed") : "Done";
			return `${head} · ${lines === 0 ? "no output" : plural(lines, "line")}`;
		}
		case "edit": {
			const diff = details(result).diff;
			if (typeof diff !== "string") return result.isError ? "Failed" : "Edited";
			const { added, removed } = diffStats(diff);
			return `+${added} −${removed}`;
		}
		case "write": {
			const content = str(args.content);
			return `${plural(countLines(content), "line")} written`;
		}
		case "grep": {
			if (text === "No matches found") return "No matches";
			const files = new Set<string>();
			let matches = 0;
			for (const line of text.split("\n")) {
				const match = /^(.+?):\d+: /.exec(line);
				if (!match) continue;
				matches++;
				files.add(match[1]!);
			}
			return `${plural(matches, "match", "matches")} in ${plural(files.size, "file")}`;
		}
		case "find":
			return text === "No files found matching pattern" ? "No files" : plural(countLines(text), "file");
		case "ls":
			return text === "(empty directory)" ? "Empty" : plural(countLines(text), "entry", "entries");
		default:
			return text ? plural(countLines(text), "line") : "Done";
	}
}

export function summarizeGeneric(result: ToolResultSnapshot | undefined): string {
	const text = resultText(result);
	const lines = text.split("\n").filter((line) => line.trim());
	const head = sanitizeText((lines[0] ?? "").replace(/^#+\s+/, ""));
	const counts = lines.length ? plural(lines.length, "line") : "Done";
	return counts + (head ? ` · ${head}` : "");
}

/** Last meaningful lines of a result, used for error tails and expanded previews. */
export function resultLines(result: ToolResultSnapshot | undefined, max: number, keep: "head" | "tail" = "tail"): string[] {
	const lines = resultText(result)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "");
	if (lines.length <= max) return lines;
	return keep === "head" ? lines.slice(0, max) : lines.slice(-max);
}

export function resultLineTotal(result: ToolResultSnapshot | undefined): number {
	return resultText(result).split("\n").filter((line) => line.trim() !== "").length;
}
