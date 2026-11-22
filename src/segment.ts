/**
 * Pure pieces of the fold model (fold-more.md §5): how a content block of an assistant message
 * takes part in a segment, which shell commands count as changes, and the summary line text.
 * Streaming and seed both go through these functions, so a resumed session folds the same way.
 */
import { argsOf, formatDuration, plural, str, thoughtLabel } from "./format.js";
import { isMergeableTool, isShellTool, skillReadName } from "./tool-summary.js";

export interface FoldPolicy {
	/** Fold on at all; off leaves rows and read-only groups exactly as before. */
	enabled: boolean;
	/** Fewest items a segment needs before it folds into one summary line. */
	minItems: number;
	/** Thinking runs join segments; false (`thinking.lines = 0`) makes them text boundaries. */
	thinking: boolean;
	/** Whether this plugin draws the tool's row; any other tool is an opaque boundary. */
	manage: (name: string) => boolean;
}

export const FOLD_OFF: FoldPolicy = {
	enabled: false,
	minItems: 2,
	thinking: true,
	manage: () => false,
};

/**
 * - `fold`: joins the current segment;
 * - `text`: visible text (or a thinking run when thinking does not fold) ends the segment;
 * - `mutation`: edit/write or a changing command ends the segment and stands alone;
 * - `opaque`: an unmanaged tool or a SKILL.md read ends the segment and draws itself as before;
 * - `skip`: nothing on screen (empty text or thinking, unknown block types).
 */
export type BlockClass = "fold" | "text" | "mutation" | "opaque" | "skip";

interface BlockLike {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
}

/**
 * Classify one content block. `final` says whether a tool call's arguments are complete: until
 * then a shell command or a read joins provisionally, because its arguments may still turn it
 * into a change or a skill load (§5.2).
 */
export function classifyBlock(block: unknown, policy: FoldPolicy, final = true): BlockClass {
	if (!block || typeof block !== "object") return "skip";
	const value = block as BlockLike;
	if (value.type === "text") {
		return typeof value.text === "string" && value.text.trim() ? "text" : "skip";
	}
	if (value.type === "thinking") {
		if (!thinkingText(value).trim()) return "skip";
		return policy.thinking ? "fold" : "text";
	}
	if (value.type === "toolCall") {
		const name = typeof value.name === "string" ? value.name : "";
		if (!name || !policy.manage(name)) return "opaque";
		const args = argsOf(value.arguments);
		if (isShellTool(name)) {
			if (!final) return "fold";
			return isMutatingShell(str(args.command)) ? "mutation" : "fold";
		}
		if (isMergeableTool(name)) {
			if (final && skillReadName(name, args) !== undefined) return "opaque";
			return "fold";
		}
		// edit, write, and any other managed tool that changes things.
		return "mutation";
	}
	return "skip";
}

function thinkingText(block: BlockLike): string {
	return typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
}

/** A thinking run as pi draws it: consecutive thinking blocks with at least one non-empty block. */
export interface ThinkingRun {
	/** pi's run index: counts only runs with text, the same way pi numbers its click overrides. */
	runIndex: number;
	text: string;
	firstBlock: number;
	lastBlock: number;
}

/** pi's grouping of thinking blocks into runs, including which runs get no index (all empty). */
export function thinkingRuns(content: unknown): ThinkingRun[] {
	if (!Array.isArray(content)) return [];
	const runs: ThinkingRun[] = [];
	let runIndex = 0;
	for (let index = 0; index < content.length; index++) {
		if (!isThinkingBlock(content[index])) continue;
		const first = index;
		const parts: string[] = [];
		for (; index < content.length && isThinkingBlock(content[index]); index++) {
			const text = thinkingText(content[index] as BlockLike).trim();
			if (text) parts.push(text);
		}
		index--;
		if (parts.length === 0) continue;
		runs.push({ runIndex: runIndex++, text: parts.join("\n\n"), firstBlock: first, lastBlock: index });
	}
	return runs;
}

function isThinkingBlock(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && (value as BlockLike).type === "thinking");
}

/** Anchor key of a thinking run: persisted data has the message timestamp but no message id. */
export function thinkingAnchor(timestamp: number, runIndex: number): string {
	return `msg:${timestamp}#${runIndex}`;
}

// ---------------------------------------------------------------------------
// isMutatingShell
// ---------------------------------------------------------------------------

const GIT_CHANGES = new Set([
	"commit", "push", "reset", "checkout", "merge", "rebase", "stash", "apply",
	"switch", "restore", "clean", "rm", "mv", "cherry-pick", "revert", "pull", "am",
]);

const FILE_CHANGES = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "unlink", "truncate", "tee",
	// PowerShell cmdlets and the aliases cmd.exe users type.
	"remove-item", "move-item", "copy-item", "new-item", "rename-item", "set-content", "add-content",
	"clear-content", "out-file", "set-itemproperty", "ri", "mi", "cpi", "ni", "del", "erase", "rd",
	"ren", "move", "copy", "md",
]);

const INSTALLERS: Record<string, Set<string>> = {
	npm: new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "ci", "update", "up", "upgrade", "link"]),
	pnpm: new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link"]),
	yarn: new Set(["install", "add", "remove", "upgrade", "up", "link"]),
	bun: new Set(["install", "i", "add", "remove", "rm", "update", "upgrade", "link"]),
	pip: new Set(["install", "uninstall"]),
	pip3: new Set(["install", "uninstall"]),
	uv: new Set(["add", "remove", "sync", "pip"]),
	cargo: new Set(["install", "uninstall", "add", "remove"]),
	go: new Set(["get", "install"]),
	apt: new Set(["install", "remove", "purge", "upgrade"]),
	"apt-get": new Set(["install", "remove", "purge", "upgrade"]),
	brew: new Set(["install", "uninstall", "upgrade"]),
	winget: new Set(["install", "uninstall", "upgrade"]),
	choco: new Set(["install", "uninstall", "upgrade"]),
	scoop: new Set(["install", "uninstall", "update"]),
};

/** Words in front of the real command that do not change what it is. */
const PREFIXES = new Set(["sudo", "command", "builtin", "exec", "time", "nice", "nohup", "env", "xargs", "doas"]);

/** Output targets that are not files. */
const NULL_TARGETS = /^(?:\/dev\/(?:null|stdout|stderr|tty)|\$null|nul)$/i;

/**
 * Conservative test for a shell command that changes files, git state, or installed packages
 * (fold-more.md §5.2). A false positive only shows one more row, a false negative hides a change
 * inside a summary, so anything that looks like a change counts.
 */
export function isMutatingShell(command: string): boolean {
	// `bash -c "…"` / `powershell -Command '…'`: the quoted script is the real command.
	for (const match of command.matchAll(NESTED_SCRIPT)) {
		const script = match[2];
		if (script && isMutatingShell(script)) return true;
	}
	const source = stripQuoted(command);
	if (hasFileRedirect(source)) return true;
	for (const segment of source.split(/\|\||&&|[;|&\n()`]|\$\(/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		let index = 0;
		while (index < words.length) {
			const word = words[index]!;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith("-") || PREFIXES.has(commandName(word))) {
				index++;
				continue;
			}
			break;
		}
		const name = commandName(words[index] ?? "");
		if (!name) continue;
		const rest = words.slice(index + 1);
		if (FILE_CHANGES.has(name)) return true;
		if (name === "find") {
			if (rest.includes("-delete")) return true;
			const exec = rest.findIndex((word) => word === "-exec" || word === "-execdir");
			if (exec >= 0 && FILE_CHANGES.has(commandName(rest[exec + 1] ?? ""))) return true;
		}
		if ((name === "sed" || name === "perl") && rest.some((word) => /^-[A-Za-z]*i/.test(word) || word.startsWith("--in-place"))) {
			return true;
		}
		if (name === "git") {
			const sub = rest.find((word, position) => !word.startsWith("-") && !isGitOptionValue(rest, position));
			if (sub && GIT_CHANGES.has(sub.toLowerCase())) return true;
		}
		const installer = INSTALLERS[name];
		if (installer) {
			const sub = rest.find((word) => !word.startsWith("-"));
			if (sub ? installer.has(sub.toLowerCase()) : name === "yarn" || name === "bun") return true;
		}
	}
	return false;
}

/** `git -C dir status`: the word after -C / -c is the option's value, not the subcommand. */
function isGitOptionValue(words: string[], position: number): boolean {
	const previous = words[position - 1];
	return previous === "-C" || previous === "-c" || previous === "--git-dir" || previous === "--work-tree";
}

function commandName(word: string): string {
	const base = word.replace(/\\/g, "/").split("/").pop() ?? "";
	return base.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

const NESTED_SCRIPT = /\b(?:sh|bash|zsh|dash|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-{1,2}\w+\s+)*?(?:-c|-Command|\/c)\s+(['"])([\s\S]*?)\1/gi;

/**
 * Replace quoted strings and heredoc bodies with a placeholder so operators inside them do not
 * count. The rest of a heredoc's first line (`cat <<EOF > out`) stays.
 */
function stripQuoted(command: string): string {
	return command
		.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\1[ \t]*(?=\n|$)/g, (_match, _tag, rest: string) => ` Q ${rest}`)
		.replace(/'[^']*'/g, "Q")
		.replace(/"(?:\\.|[^"\\])*"/g, "Q");
}

function hasFileRedirect(source: string): boolean {
	const pattern = /(?:^|[^<>=-])(?:\d|&)?>>?\|?\s*([^\s;|&()<>]+)?/g;
	for (const match of source.matchAll(pattern)) {
		const target = match[1];
		if (!target) continue;
		// 2>&1, >&2: duplicating a descriptor writes no file.
		if (target.startsWith("&")) continue;
		if (NULL_TARGETS.test(target)) continue;
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

export interface FoldStats {
	thinking: {
		count: number;
		/** Summed `durationMs` of the messages with thinking; undefined when none is known. */
		ms?: number;
		active: boolean;
	};
	commands: { count: number; active: boolean };
	reads: number;
	searches: number;
	lists: number;
	/** A read, search, or listing is still running. */
	exploreActive: boolean;
	tools: number;
	/** Tools that failed; interrupted ones are counted apart and are not failures (DESIGN.md §9). */
	failed: number;
	interrupted: number;
}

/**
 * The parts of a segment's summary line, without the failure count. Each kind takes its own
 * tense: `Thinking 12s · Ran 2 commands · Read 5 files` (fold-more.md §5.4).
 */
export function summaryParts(stats: FoldStats): string[] {
	const parts: string[] = [];
	const { thinking, commands } = stats;
	if (thinking.count > 0) {
		if (thinking.active) {
			parts.push(thinking.ms !== undefined && thinking.ms >= 1_000 ? `Thinking ${formatDuration(thinking.ms)}` : "Thinking");
		} else if (thinking.ms !== undefined) {
			// Same wording as the list items under it (`Thought for 1.5s`).
			parts.push(thoughtLabel(thinking.ms));
		}
	}
	if (commands.count > 0) {
		parts.push(`${commands.active ? "Running" : "Ran"} ${plural(commands.count, "command")}`);
	}
	const explore = stats.exploreActive;
	if (stats.reads > 0) {
		parts.push(`${explore ? "Reading" : "Read"} ${plural(stats.reads, "file")}`);
		if (stats.searches > 0) parts.push(plural(stats.searches, "search", "searches"));
		if (stats.lists > 0) parts.push(plural(stats.lists, "dir"));
	} else if (stats.searches > 0) {
		parts.push(`${explore ? "Searching" : "Searched"} ${plural(stats.searches, "pattern")}`);
		if (stats.lists > 0) parts.push(plural(stats.lists, "dir"));
	} else if (stats.lists > 0) {
		parts.push(`${explore ? "Listing" : "Listed"} ${plural(stats.lists, "dir")}`);
	}
	// Only thinking with no known duration (an old session): still say what the line stands for.
	if (parts.length === 0) parts.push(thinking.active ? "Thinking" : "Thought");
	return parts;
}

export function summaryText(stats: FoldStats): string {
	return summaryParts(stats).join(" · ");
}

/** Column-0 marker of a summary line: none, `!` when some tools failed, `×` when all did. */
export function summaryMarker(stats: FoldStats): " " | "!" | "×" {
	if (stats.failed === 0) return " ";
	return stats.failed >= stats.tools ? "×" : "!";
}
