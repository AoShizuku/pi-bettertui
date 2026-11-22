import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashExecutionComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	installUserShellPatch,
	PREVIEW_LINES,
	readUserShell,
	refreshLiveUserShells,
	renderUserShellBox,
	uninstallUserShellPatches,
	type UserShellHooks,
} from "./user-shell.js";

/** Each color token gets its own SGR code so tests can tell which color a piece of text has. */
const CODES: Record<string, number> = { bashMode: 31, dim: 32, error: 33, warning: 34, muted: 35, text: 36 };
const theme = {
	fg: (token: string, text: string) => `\x1b[${CODES[token] ?? 37}m${text}\x1b[39m`,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

// eslint-disable-next-line no-control-regex
const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");
const colored = (token: string, text: string) => `\x1b[${CODES[token]}m${text}`;

type Status = "running" | "complete" | "cancelled" | "error";

/** Stand-in for pi's BashExecutionComponent: the same private fields and own methods. */
class FakeShell {
	command: string;
	outputLines: string[] = [];
	status: Status = "running";
	exitCode: number | undefined = undefined;
	expanded = false;
	colorKey: "dim" | "bashMode";
	truncationResult?: { truncated: boolean };
	fullOutputPath?: string;
	contentContainer = { children: [{}] as unknown[] };

	constructor(command: string, excludeFromContext = false) {
		this.command = command;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
	}

	render(_width: number): string[] {
		return ["native"];
	}

	appendOutput(chunk: string): void {
		const parts = chunk.split("\n");
		const last = this.outputLines.length - 1;
		if (last >= 0) {
			this.outputLines[last] = `${this.outputLines[last] ?? ""}${parts[0] ?? ""}`;
			this.outputLines.push(...parts.slice(1));
		} else {
			this.outputLines.push(...parts);
		}
		this.bump();
	}

	setComplete(exitCode: number | undefined, cancelled: boolean, truncationResult?: { truncated: boolean }, fullOutputPath?: string): void {
		this.exitCode = exitCode;
		this.status = cancelled ? "cancelled" : exitCode !== 0 && exitCode !== undefined ? "error" : "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;
		this.bump();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.bump();
	}

	getCommand(): string {
		return this.command;
	}

	/** pi rebuilds its content on every change. */
	private bump(): void {
		this.contentContainer.children = [{}];
	}
}

let enabled = true;
let foldAnswered = true;
let root: unknown;
const hooks: UserShellHooks = {
	isEnabled: () => enabled,
	getTheme: () => theme,
	expandKey: () => "ctrl+o",
	foldAnswered: () => foldAnswered,
	getRoot: () => root,
};

/** Stand-in for pi's UserMessageComponent, as gutter.ts recognizes it. */
function userMessage(text = "next question") {
	return { text, markdownTheme: {}, rebuild() {}, setOutputPad() {}, render: () => [text] };
}

const click = (component: FakeShell, y = 2) =>
	(component as unknown as { handleMouse: (event: object) => unknown }).handleMouse({ type: "click", button: "left", x: 3, y });

/** A finished block in a chat container, with the TUI tree as the hooks' root. */
function answeredShell(command: string, output: string, below: unknown[] = [userMessage()]) {
	const component = new FakeShell(command);
	const chat = { children: [component, ...below] as unknown[] };
	root = { children: [chat] };
	expect(refreshLiveUserShells(root, hooks)).toBeGreaterThanOrEqual(1);
	if (output) component.appendOutput(output);
	component.setComplete(0, false);
	return { component, chat };
}

/** A shell block in a fake TUI tree, with its prototype patched the live way. */
function shell(command: string, excludeFromContext = false): FakeShell {
	const component = new FakeShell(command, excludeFromContext);
	expect(refreshLiveUserShells({ children: [{ children: [component] }] }, hooks)).toBe(1);
	return component;
}

function expectFits(lines: string[], width: number): void {
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

beforeEach(() => {
	enabled = true;
	foldAnswered = true;
	root = undefined;
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});

afterEach(() => {
	vi.useRealTimers();
	uninstallUserShellPatches();
});

describe("user shell box", () => {
	it("draws `!` with a bashMode frame, no blank rows inside, and the status in the top border", () => {
		const component = shell("pi install npm:pi-pretty-tui");
		component.render(50);
		component.appendOutput("added 12 packages in 3s\n");
		vi.advanceTimersByTime(1_234);
		component.setComplete(0, false);
		const lines = component.render(50);
		expect(lines.map(plain)).toEqual([
			"",
			"╭─ ! sh ───────────────────────── exit 0 · 1.2s ─╮",
			"│ pi install npm:pi-pretty-tui                   │",
			"│ added 12 packages in 3s                        │",
			"╰────────────────────────────────────────────────╯",
		]);
		expect(lines[1]!.startsWith(colored("bashMode", "╭─ "))).toBe(true);
		expect(lines[2]!.startsWith(colored("bashMode", "│"))).toBe(true);
		expect(lines[3]).toContain(colored("muted", "added 12 packages"));
		expectFits(lines, 50);
	});

	it("names `!!` as kept out of the context and draws it dim", () => {
		const component = shell("git status --short", true);
		component.render(50);
		vi.advanceTimersByTime(3_400);
		const lines = component.render(50);
		expect(plain(lines[1]!).startsWith("╭─ !! sh · 不进上下文 ─")).toBe(true);
		expect(plain(lines[1]!).endsWith(" Running… 3s ─╮")).toBe(true);
		expect(visibleWidth(lines[1]!)).toBe(50);
		expect(lines[1]!.startsWith(colored("dim", "╭─ "))).toBe(true);
		expect(lines[1]).not.toContain(colored("bashMode", ""));
		expect(lines.map(plain).slice(2)).toEqual([
			"│ git status --short                             │",
			"╰────────────────────────────────────────────────╯",
		]);
	});

	it("ticks the running time on each render", () => {
		const component = shell("sleep 5");
		expect(plain(component.render(40)[1]!)).toContain("Running… 0s");
		vi.advanceTimersByTime(2_100);
		expect(plain(component.render(40)[1]!)).toContain("Running… 2s");
		vi.advanceTimersByTime(61_000);
		expect(plain(component.render(40)[1]!)).toContain("Running… 1m 3s");
	});

	it("shows a non-zero exit in the error color", () => {
		const component = shell("false");
		component.render(40);
		vi.advanceTimersByTime(500);
		component.setComplete(2, false);
		const top = component.render(40)[1]!;
		expect(plain(top).endsWith(" exit 2 · 500ms ─╮")).toBe(true);
		expect(top).toContain(colored("error", "exit 2"));
	});

	it("shows a cancelled command in the warning color", () => {
		const component = shell("sleep 100");
		component.render(40);
		vi.advanceTimersByTime(70_000);
		component.setComplete(undefined, true);
		const top = component.render(40)[1]!;
		expect(plain(top).endsWith(" cancelled · 1m 10s ─╮")).toBe(true);
		expect(top).toContain(colored("warning", "cancelled"));
	});

	it("leaves the duration out for a command restored from history", () => {
		const component = new FakeShell("ls");
		component.appendOutput("a\nb");
		component.setComplete(0, false);
		refreshLiveUserShells({ children: [component] }, hooks);
		const lines = component.render(30).map(plain);
		expect(lines[1]!.endsWith(" exit 0 ─╮")).toBe(true);
		expect(lines.slice(2)).toEqual([
			"│ ls                         │",
			"│ a                          │",
			"│ b                          │",
			"╰────────────────────────────╯",
		]);
	});

	it("wraps long and multi-line commands and long output inside the frame", () => {
		const component = shell("echo one \\\n  && echo 两个很长的中文词语一直写下去");
		component.appendOutput(`${"x".repeat(30)}\n中文输出中文输出中文输出中文`);
		component.setComplete(0, false);
		const lines = component.render(20);
		expectFits(lines, 20);
		for (const line of lines.slice(2, -1)) {
			expect(plain(line).startsWith("│ ")).toBe(true);
			expect(plain(line).endsWith(" │")).toBe(true);
			expect(visibleWidth(line)).toBe(20);
		}
		const text = lines.slice(2, -1).map((line) => plain(line).slice(2, -2).trimEnd());
		expect(text.join("")).toContain("x".repeat(16));
		expect(text.some((line) => line.trim() === "")).toBe(false);
		expect(lines.length).toBeGreaterThan(6);
	});

	it("keeps the last 20 lines and counts the rest in the bottom border; Ctrl+O shows all", () => {
		const component = shell("seq 32");
		component.appendOutput(Array.from({ length: 32 }, (_, index) => String(index + 1)).join("\n") + "\n");
		component.setComplete(0, false);
		const collapsed = component.render(60).map(plain);
		// blank, top, command, 20 output rows, bottom
		expect(collapsed).toHaveLength(1 + 1 + 1 + PREVIEW_LINES + 1);
		expect(collapsed[3]).toContain("│ 13 ");
		expect(collapsed[collapsed.length - 2]).toContain("│ 32 ");
		expect(collapsed[collapsed.length - 1]!.startsWith("╰─ … 12 more lines · ctrl+o to expand ─")).toBe(true);
		expect(collapsed[collapsed.length - 1]!.endsWith("─╯")).toBe(true);

		component.setExpanded(true);
		const expanded = component.render(60).map(plain);
		expect(expanded).toHaveLength(1 + 1 + 1 + 32 + 1);
		expect(expanded[expanded.length - 1]!.startsWith("╰─ ctrl+o to collapse ─")).toBe(true);
	});

	it("puts the truncation notice and full-output path in the bottom border, clipped to fit", () => {
		const component = shell("cat big.log");
		component.appendOutput("tail\n");
		component.setComplete(0, false, { truncated: true }, "/tmp/pi-bash-0123456789abcdef.log");
		const wide = component.render(80);
		expect(plain(wide[wide.length - 1]!)).toContain("truncated · full output: /tmp/pi-bash-0123456789abcdef.log");
		expect(wide[wide.length - 1]).toContain(colored("warning", "truncated"));
		const narrow = component.render(30);
		expectFits(narrow, 30);
		expect(plain(narrow[narrow.length - 1]!)).toMatch(/^╰─ truncated · full outp.*… ─*╯$/);
	});

	it("degrades on narrow widths without overflowing", () => {
		const component = shell("printf 'wide 宽字符'", true);
		component.appendOutput("宽字符输出\n");
		component.setComplete(1, false);
		for (const width of [0, 1, 3, 5, 6, 8, 12, 16, 24]) {
			const lines = component.render(width);
			expect(lines[0]).toBe("");
			expectFits(lines, Math.max(0, width));
		}
		// Too narrow for a title: a bare frame.
		expect(plain(component.render(8)[1]!)).toBe("╭──────╮");
		// The status outranks the long `!!` title.
		expect(plain(component.render(24)[1]!)).toBe("╭─ !! sh ───── exit 1 ─╮");
	});

	it("falls back to pi's own render when a field is missing", () => {
		const component = shell("ls");
		(component as { status: unknown }).status = "weird";
		expect(component.render(40)).toEqual(["native"]);
		const other = shell("ls");
		delete (other as { colorKey?: unknown }).colorKey;
		expect(other.render(40)).toEqual(["native"]);
		expect(readUserShell({ command: "ls" })).toBeUndefined();
	});

	it("renders as pi does when the plugin is off, and after uninstall", () => {
		const component = shell("ls");
		enabled = false;
		expect(component.render(40)).toEqual(["native"]);
		enabled = true;
		expect(component.render(40)).not.toEqual(["native"]);
		uninstallUserShellPatches();
		expect(component.render(40)).toEqual(["native"]);
		expect(Object.prototype.hasOwnProperty.call(FakeShell.prototype, "render")).toBe(true);
	});

	it("never patches a prototype that only inherits the shell methods", () => {
		const proto = Object.create(FakeShell.prototype);
		const sub = Object.assign(Object.create(proto), new FakeShell("ls")) as FakeShell;
		refreshLiveUserShells({ children: [sub] }, hooks);
		expect(Object.prototype.hasOwnProperty.call(proto, "render")).toBe(false);
		expect(sub.render(40)).toEqual(["native"]);
	});
});

describe("folding a block answered by a user message", () => {
	const output = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

	it("folds to three rows once a user message sits below it", () => {
		const { component, chat } = answeredShell("git log --oneline", output, []);
		expect(component.render(40)).toHaveLength(18);
		chat.children.push(userMessage());
		const lines = component.render(40).map(plain);
		expect(lines).toEqual([
			"",
			"╭─ ! sh ────────────────────── exit 0 ─╮",
			"│ git log --oneline                    │",
			"╰─ … 14 lines · click to show ─────────╯",
		]);
		expectFits(component.render(40), 40);
	});

	it("does not count another shell block, and stays off when the switch is off", () => {
		const other = new FakeShell("pwd");
		const { component, chat } = answeredShell("ls", output, [other]);
		expect(component.render(40)).toHaveLength(18);
		chat.children.push(userMessage());
		expect(component.render(40)).toHaveLength(4);
		foldAnswered = false;
		expect(component.render(40)).toHaveLength(18);
	});

	it("never folds a running block", () => {
		const component = new FakeShell("npm install");
		root = { children: [{ children: [component, userMessage()] }] };
		refreshLiveUserShells(root, hooks);
		component.appendOutput(output);
		expect(component.render(40)).toHaveLength(18);
		component.setComplete(0, false);
		expect(component.render(40)).toHaveLength(4);
	});

	it("opens on a click with a hint to hide it, and folds again on the next click", () => {
		const { component } = answeredShell("git log --oneline", output);
		component.render(40);
		// pi's blank line above the box is not part of it.
		expect(click(component, 0)).toBeUndefined();
		expect(click(component)).toEqual({ handled: true });
		const open = component.render(40).map(plain);
		expect(open).toHaveLength(18);
		expect(open.at(-1)).toBe("╰─ click to hide ──────────────────────╯");
		expect(click(component, 1)).toEqual({ handled: true });
		expect(component.render(40)).toHaveLength(4);
	});

	it("lets Ctrl+O show everything and hand every block back to the toggle", () => {
		const long = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
		const { component } = answeredShell("seq 30", long);
		component.setExpanded(true);
		const expanded = component.render(40).map(plain);
		expect(expanded).toHaveLength(34);
		expect(expanded.at(-1)).toContain("ctrl+o to collapse · click to hide");
		click(component);
		expect(component.render(40)).toHaveLength(4);
		// Ctrl+O again drops the click and follows the toggle.
		component.setExpanded(false);
		expect(component.render(40)).toHaveLength(4);
		click(component);
		const preview = component.render(60).map(plain);
		expect(preview).toHaveLength(24);
		expect(preview.at(-1)).toContain("… 10 more lines · ctrl+o to expand · click to hide");
	});

	it("keeps the first row of a multi-line command, and leaves a block with nothing to fold alone", () => {
		const multi = answeredShell("cd src\nnpm test", "");
		expect(multi.component.render(40).map(plain).slice(2)).toEqual([
			"│ cd src …                             │",
			"╰─ … click to show ────────────────────╯",
		]);
		const short = answeredShell("true", "");
		expect(short.component.render(40).map(plain).slice(2)).toEqual([
			"│ true                                 │",
			"╰──────────────────────────────────────╯",
		]);
		expect(click(short.component)).toBeUndefined();
	});

	it("finds a block again after pi moves it to another container", () => {
		const component = new FakeShell("ls");
		const pending = { children: [component] as unknown[] };
		const chat = { children: [userMessage("earlier")] as unknown[] };
		root = { children: [chat, pending] };
		refreshLiveUserShells(root, hooks);
		component.appendOutput(output);
		component.setComplete(0, false);
		expect(component.render(40)).toHaveLength(18);
		pending.children = [];
		chat.children.push(component, userMessage());
		expect(component.render(40)).toHaveLength(4);
	});

	it("folds in the narrow frameless layout too", () => {
		const { component } = answeredShell("cd src\nnpm test", output);
		expect(component.render(5).map(plain)).toEqual(["", "cd sr"]);
	});
});

describe("pi's BashExecutionComponent", () => {
	initTheme("dark");
	const ui = { requestRender: () => {} };

	it("is read and boxed from its v1.5.0 fields, and restored on uninstall", () => {
		installUserShellPatch(hooks);
		const component = new BashExecutionComponent("echo hi", ui as any, true, 1);
		component.appendOutput("hi\n");
		component.setComplete(0, false);
		expect(readUserShell(component)).toMatchObject({ command: "echo hi", status: "complete", exitCode: 0, excludeFromContext: true });
		const boxed = component.render(40).map(plain);
		expect(boxed[1]!.startsWith("╭─ !! sh · 不进上下文 ─")).toBe(true);
		expect(boxed.slice(2)).toEqual([
			"│ echo hi                              │",
			"│ hi                                   │",
			"╰──────────────────────────────────────╯",
		]);
		uninstallUserShellPatches();
		expect(Object.prototype.hasOwnProperty.call(BashExecutionComponent.prototype, "render")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(BashExecutionComponent.prototype, "handleMouse")).toBe(false);
		expect(component.render(40).map(plain).some((line) => line.includes("$ echo hi"))).toBe(true);
	});
});
