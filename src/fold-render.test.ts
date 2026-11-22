import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { type BetterTuiConfig, DEFAULT_CONFIG } from "./config.js";
import type { FoldPolicy } from "./segment.js";
import { installThinkingPatch } from "./thinking.js";
import { ActivityTimeline } from "./timeline.js";
import { RUNNING_BLOCK_DELAY_MS } from "./tool-lines.js";
import { createToolRenderers } from "./tool-row.js";
import { isManagedTool } from "./tool-summary.js";

const tokens: Array<[string, string]> = [];
const theme = {
	fg: (token: string, text: string) => {
		tokens.push([token, text]);
		return text;
	},
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

// eslint-disable-next-line no-control-regex
const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\]133;[A-C]\x07/g, "").trimEnd();

let config: BetterTuiConfig = structuredClone(DEFAULT_CONFIG);
let timeline = new ActivityTimeline();

function policy(overrides: Partial<FoldPolicy> = {}): FoldPolicy {
	return { enabled: true, minItems: 2, thinking: true, manage: isManagedTool, ...overrides };
}

function context(toolCallId: string, args: Record<string, unknown>, expanded = false) {
	return {
		args,
		toolCallId,
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: false,
		argsComplete: true,
		isPartial: true,
		expanded,
		showImages: true,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		keyHint: () => "",
		keyText: () => "",
	} as any;
}

function view(name: string, id: string, args: Record<string, unknown>, expanded = false) {
	const renderers = createToolRenderers(name, undefined, { timeline, getConfig: () => config, getTheme: () => theme });
	const component = renderers.renderCall!(args, theme, context(id, args, expanded));
	return {
		render: (width = 80) => component.render(width).map(plain),
		click: (y: number) => (component as any).handleMouse({ type: "click", button: "left", y }),
	};
}

function assistantMessage(timestamp: number, content: unknown[], extra: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content,
		api: "openai",
		provider: "openai",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: content.some((block: any) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
		durationMs: 2_000,
		...extra,
	};
}

function assistantComponent(message: ReturnType<typeof assistantMessage>, streaming = false) {
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
	component.updateContent(message as any, streaming);
	return { component, render: (width = 80) => component.render(width).map(plain) };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const done = (id: string, output = "ok", isError = false) => timeline.end(id, { content: [{ type: "text", text: output }], isError }, Date.now());
/** The command `id` started running `ago` ms before now (tool_execution_start). */
const running = (id: string, ago: number) => {
	const row = timeline.row(id)!;
	row.execStartedAt = undefined;
	timeline.startExecution(id, Date.now() - ago);
};

initTheme("dark");
const cleanup = installThinkingPatch({
	isEnabled: () => true,
	getLines: () => config.thinking.lines,
	getTheme: () => theme,
	getActiveTui: () => undefined,
	fold: { get timeline() { return timeline; }, getConfig: () => config, getCwd: () => "/repo" },
});
afterAll(() => cleanup());

beforeEach(() => {
	config = structuredClone(DEFAULT_CONFIG);
	timeline = new ActivityTimeline();
	timeline.setFoldPolicy(policy());
	tokens.length = 0;
});

describe("fold host on a tool row while the run goes on", () => {
	it("draws the list, not a summary, in the first row; the others draw nothing", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [
			call("b1", "bash", { command: "npm run build", description: "构建" }),
			call("r1", "read", { file_path: "/repo/src/a.ts" }),
		]), false);
		const host = view("bash", "b1", { command: "npm run build", description: "构建" });
		const member = view("read", "r1", { file_path: "/repo/src/a.ts" });
		running("b1", 2_000);
		timeline.update("b1", { content: [{ type: "text", text: "one\ntwo" }] }, 0);

		expect(member.render()).toEqual([]);
		expect(host.render()).toEqual([
			"  ├ Bash (构建) · Running… 2s",
			"  │  $ npm run build",
			"  │",
			"  │  one",
			"  │  two",
			"  │",
			"  └ Read (src/a.ts) · running",
		]);

		// Finished items stay in the list as one line each; nothing collapses yet.
		done("r1");
		done("b1");
		expect(host.render()).toEqual(["  ├ Bash (构建) · Done · 1 line", "  └ Read (src/a.ts) · 1 line"]);
		// A boundary in the middle of the run closes the segment but keeps the list.
		timeline.closeSegment();
		expect(host.render()).toHaveLength(2);

		// The run settles: one summary line, in the past tense.
		timeline.settle();
		expect(host.render()).toEqual(["  Ran 1 command · Read 1 file ▸"]);
		expect(member.render()).toEqual([]);
	});

	it("appends items: the last one takes └, the one above turns into ├, and the height only grows", () => {
		const first = [call("r1", "read", { file_path: "/a" })];
		timeline.ingestAssistant(assistantMessage(1_000, first, { stopReason: undefined }), true);
		const host = view("read", "r1", { file_path: "/a" });
		// One item: below the threshold, the row draws itself in one line.
		expect(host.render()).toEqual(["● Read (/a) · Running…"]);

		const second = [...first, call("r2", "read", { file_path: "/b" })];
		timeline.ingestAssistant(assistantMessage(1_000, second, { stopReason: undefined }), true);
		expect(host.render()).toEqual(["  ├ Read (/a) · running", "  └ Read (/b) · running"]);

		timeline.ingestAssistant(assistantMessage(1_000, [...second, call("g1", "grep", { pattern: "x", path: "src" })]), false);
		expect(host.render()).toEqual([
			"  ├ Read (/a) · running",
			"  ├ Read (/b) · running",
			"  └ Grep (/x/ in src) · running",
		]);
	});

	it("opens a command's preview only after it has run for a second, at a fixed height", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [
			call("r1", "read", { file_path: "/repo/a.ts" }),
			call("b1", "bash", { command: "npm test" }),
		]), false);
		done("r1");
		const host = view("read", "r1", { file_path: "/repo/a.ts" });
		// Arguments complete but not running yet, then running for half a second: one line.
		expect(host.render()).toEqual(["  ├ Read (a.ts) · 1 line", "  └ Bash (npm test) · Running…"]);
		running("b1", RUNNING_BLOCK_DELAY_MS / 2);
		timeline.update("b1", { content: [{ type: "text", text: "a" }] }, 0);
		expect(host.render()).toHaveLength(2);

		running("b1", RUNNING_BLOCK_DELAY_MS + 500);
		const heights: number[] = [];
		for (const output of ["a", "a\nb\nc", "a\nb\nc\nd\ne\nf"]) {
			timeline.update("b1", { content: [{ type: "text", text: output }] }, 0);
			heights.push(host.render().length);
		}
		// Two item lines + 3 output lines; no description, so no script lines.
		expect(new Set(heights)).toEqual(new Set([5]));
		expect(host.render().slice(-3)).toEqual(["     d", "     e", "     f"]);

		// Done: the preview goes, the item stays one line.
		done("b1", "pass");
		expect(host.render()).toEqual(["  ├ Read (a.ts) · 1 line", "  └ Bash (npm test) · Done · 1 line"]);
	});

	it("never opens a preview for a command that ends within the first second", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [
			call("r1", "read", { file_path: "/a" }),
			call("b1", "bash", { command: "git status" }),
		]), false);
		done("r1");
		const host = view("read", "r1", { file_path: "/a" });
		running("b1", 0);
		const heights = [host.render().length];
		timeline.update("b1", { content: [{ type: "text", text: "clean" }] }, 0);
		heights.push(host.render().length);
		done("b1", "clean");
		heights.push(host.render().length);
		expect(heights).toEqual([2, 2, 2]);
	});

	it("gives only the newest of several parallel commands the full block", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [
			call("b1", "bash", { command: "npm run lint" }),
			call("b2", "bash", { command: "npm run typecheck" }),
			call("b3", "bash", { command: "npm test" }),
		]), false);
		const host = view("bash", "b1", { command: "npm run lint" });
		for (const id of ["b1", "b2", "b3"]) running(id, 2_000);
		const lines = host.render();
		expect(lines.slice(0, 3)).toEqual([
			"  ├ Bash (npm run lint) · Running… 2s",
			"  ├ Bash (npm run typecheck) · Running… 2s",
			"  └ Bash (npm test) · Running… 2s",
		]);
		expect(lines).toHaveLength(3 + config.tools.shellPreviewLines);
	});

	it("opens an item's details on a click while the run goes on", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("r1", "read", { file_path: "/a" }), call("r2", "read", { file_path: "/b" })]), false);
		done("r1", "x");
		done("r2", "y");
		const host = view("read", "r1", { file_path: "/a" });
		expect(host.render()).toEqual(["  ├ Read (/a) · 1 line", "  └ Read (/b) · 1 line"]);
		host.click(1);
		expect(host.render()).toEqual(["  ├ Read (/a) · 1 line", "  └ Read (/b) · 1 line", "     y"]);
		host.click(0);
		expect(host.render()).toEqual(["  ├ Read (/a) · 1 line", "  │  x", "  └ Read (/b) · 1 line", "     y"]);
	});

	it("draws a single running command as one line, and as the fixed block after a second", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("b1", "bash", { command: "npm test", description: "测试" })]), false);
		const single = view("bash", "b1", { command: "npm test", description: "测试" });
		running("b1", 0);
		timeline.update("b1", { content: [{ type: "text", text: "ok" }] }, 0);
		expect(single.render()).toEqual(["● Bash (测试) · Running…"]);
		running("b1", 1_500);
		expect(single.render()).toEqual(["● Bash (测试) · Running… 1s", "     $ npm test", "", "     ok", "", ""]);
	});
});

describe("fold host on a tool row once the run settled", () => {
	it("counts interrupted items without a marker and keeps them in the closed list", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [
			call("r1", "read", { file_path: "/repo/a.ts" }),
			call("r2", "read", { file_path: "/repo/b.ts" }),
		]), false);
		const host = view("read", "r1", { file_path: "/repo/a.ts" });
		done("r1");
		done("r2", "Operation aborted", true);
		expect(host.render()).toEqual(["  ├ Read (a.ts) · 1 line", "  └ Read (b.ts) · interrupted"]);
		timeline.settle();
		expect(host.render()).toEqual(["  Read 2 files · 1 interrupted ▸"]);
	});

	it("marks failures in column 0 and shows the failed items under the summary", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [
			call("r1", "read", { file_path: "/repo/a.ts" }),
			call("r2", "read", { file_path: "/repo/b.ts" }),
		]), false);
		const host = view("read", "r1", { file_path: "/repo/a.ts" });
		done("r1");
		done("r2", "ENOENT", true);
		// While running, the failed item shows in the list itself.
		expect(host.render()).toEqual(["  ├ Read (a.ts) · 1 line", "  └ Read (b.ts) · failed"]);
		timeline.settle();
		expect(host.render()).toEqual(["! Read 2 files · 1 failed ▸", "  └ Read (b.ts) · failed"]);

		done("r1", "EACCES", true);
		// Every failure stays visible, so the lines match the count.
		expect(host.render()).toEqual(["× Read 2 files · 2 failed ▸", "  ├ Read (a.ts) · failed", "  └ Read (b.ts) · failed"]);
		expect(tokens.some(([token, text]) => token === "error" && text === "×")).toBe(true);
	});

	it("opens an exposed failure's details in place, without opening the list", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [
			call("r1", "read", { file_path: "/repo/a.ts" }),
			call("b1", "bash", { command: "npm test" }),
		]), false);
		const host = view("read", "r1", { file_path: "/repo/a.ts" });
		done("r1");
		done("b1", "boom", true);
		timeline.settle();
		const segment = timeline.segment("r1")!;
		expect(host.render()).toEqual(["! Ran 1 command · Read 1 file · 1 failed ▸", "  └ Bash (npm test) · failed"]);

		host.click(1);
		expect(segment.expanded).toBe(false);
		expect(host.render()).toEqual(["! Ran 1 command · Read 1 file · 1 failed ▸", "  └ Bash (npm test) · failed", "     $ npm test", "     boom"]);
		host.click(1);
		expect(host.render()).toHaveLength(2);

		// The summary still opens the whole list.
		host.click(0);
		expect(segment.expanded).toBe(true);
		expect(host.render()).toHaveLength(3);
	});

	it("caps the exposed failures and folds the earlier ones into one line that opens the list", () => {
		const ids = ["r1", "r2", "r3", "r4", "r5"];
		timeline.ingestAssistant(assistantMessage(1_000, ids.map((id) => call(id, "read", { file_path: `/${id}` }))), false);
		const host = view("read", "r1", { file_path: "/r1" });
		for (const id of ids) done(id, "ENOENT", true);
		timeline.settle();
		expect(host.render()).toEqual([
			"× Read 5 files · 5 failed ▸",
			"  ├ … 2 more failed",
			"  ├ Read (/r3) · failed",
			"  ├ Read (/r4) · failed",
			"  └ Read (/r5) · failed",
		]);
		host.click(1);
		expect(timeline.segment("r1")!.expanded).toBe(true);
	});

	it("keeps the summary a dim process line with no marker", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("r1", "read", { file_path: "/a" }), call("r2", "read", { file_path: "/b" })]), false);
		const host = view("read", "r1", { file_path: "/a" });
		done("r1");
		done("r2");
		timeline.settle();
		tokens.length = 0;
		host.render();
		expect(tokens).toContainEqual(["dim", "Read 2 files"]);
		expect(tokens.some(([token]) => token === "accent" || token === "success" || token === "text")).toBe(false);
	});

	it("follows Ctrl+O on a tool host and maps clicks to the summary and the items", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("r1", "read", { file_path: "/a" }), call("r2", "read", { file_path: "/b" })]), false);
		done("r1", "x");
		done("r2", "y");
		timeline.settle();
		const expanded = view("read", "r1", { file_path: "/a" }, true);
		expect(expanded.render()).toEqual(["  Read 2 files ▾", "  ├ Read (/a) · 1 line", "  └ Read (/b) · 1 line"]);
		expect(timeline.globalExpanded).toBe(true);

		const host = view("read", "r1", { file_path: "/a" });
		expect(timeline.globalExpanded).toBe(false);
		expect(host.render()).toEqual(["  Read 2 files ▸"]);
		host.click(0);
		expect(host.render()).toHaveLength(3);
		host.click(2);
		expect(host.render()).toEqual(["  Read 2 files ▾", "  ├ Read (/a) · 1 line", "  └ Read (/b) · 1 line", "     y"]);
		host.click(0);
		expect(host.render()).toEqual(["  Read 2 files ▸"]);
	});

	it("collapses a segment the user opened during the run, together with the rest of the run", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("r1", "read", { file_path: "/a" }), call("r2", "read", { file_path: "/b" })]), false);
		done("r1", "x");
		done("r2", "y");
		const host = view("read", "r1", { file_path: "/a" });
		expect(host.render()).toHaveLength(2);
		host.click(1);
		expect(host.render()).toHaveLength(3);
		timeline.settle();
		expect(host.render()).toEqual(["  Read 2 files ▸"]);
	});

	it("is collapsed right away after a resume", () => {
		timeline.seed([
			{ type: "message", message: { role: "user", content: "go", timestamp: 0 } },
			{ type: "message", message: assistantMessage(1_000, [call("r1", "read", { file_path: "/a" }), call("r2", "read", { file_path: "/b" })]) },
			{ type: "message", message: { role: "toolResult", toolCallId: "r1", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1 } },
			{ type: "message", message: { role: "toolResult", toolCallId: "r2", content: [{ type: "text", text: "y" }], isError: false, timestamp: 1 } },
		], true, isManagedTool);
		const host = view("read", "r1", { file_path: "/a" });
		expect(host.render()).toEqual(["  Read 2 files ▸"]);
		expect(view("read", "r2", { file_path: "/b" }).render()).toEqual([]);
	});
});

describe("fold host on a thinking region", () => {
	it("puts a running command under the thought in the list; the tool row stays empty", () => {
		const message = assistantMessage(1_000, [{ type: "thinking", thinking: "plan" }, call("b1", "bash", { command: "npm test" })]);
		const { render } = assistantComponent(message);
		const tool = view("bash", "b1", { command: "npm test" });
		expect(tool.render()).toEqual([]);
		// Seen only once complete: nothing measured, the message's one run takes its durationMs.
		expect(render()).toEqual(["", "  ├ Thought for 2.0s", "  └ Bash (npm test) · Running…"]);
		running("b1", 2_000);
		expect(render()).toEqual(["", "  ├ Thought for 2.0s", "  └ Bash (npm test) · Running… 2s", "", "", ""]);
		done("b1");
		expect(render()).toEqual(["", "  ├ Thought for 2.0s", "  └ Bash (npm test) · Done · 1 line"]);
		timeline.settle();
		expect(render()).toEqual(["", "  Thought for 2.0s · Ran 1 command ▸"]);
	});

	it("shows a streaming thought as the last item with a three-line tail, one dim timed line once it is done", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("r1", "read", { file_path: "/a" })]), false);
		done("r1");
		const host = view("read", "r1", { file_path: "/a" });
		const started = Date.now() - 5_000;
		const thought = { type: "thinking", thinking: "one\ntwo\nthree\nfour" };
		const streaming = assistantMessage(started, [thought], { durationMs: undefined, stopReason: undefined });
		const { component, render } = assistantComponent(streaming, true);

		// The message that only holds the thought draws nothing, not even pi's blank line.
		expect(render()).toEqual([]);
		expect(host.render()).toEqual(["  ├ Read (/a) · 1 line", "  └ … two", "      three", "      four"]);
		// Still streaming: the tail stays, however long it has been going.
		component.updateContent(assistantMessage(started, [{ ...thought, thinking: "one\ntwo\nthree\nfour\nfive" }], { durationMs: undefined, stopReason: undefined }) as any, true);
		expect(host.render()).toEqual(["  ├ Read (/a) · 1 line", "  └ … three", "      four", "      five"]);

		// The thought ends and a command follows: the thought becomes one dim line with its own
		// time, measured from the message's start to the moment the command appeared, and takes ├.
		const ended = [{ ...thought, thinking: "one\ntwo\nthree\nfour\nfive" }, call("b2", "bash", { command: "ls" })];
		component.updateContent(assistantMessage(started, ended, { durationMs: undefined, stopReason: undefined }) as any, true);
		tokens.length = 0;
		expect(host.render()).toEqual(["  ├ Read (/a) · 1 line", "  ├ Thought for 5.0s", "  └ Bash (ls) · Running…"]);
		expect(tokens).toContainEqual(["dim", "Thought for 5.0s"]);
		expect(tokens.some(([token]) => token === "thinkingText")).toBe(false);

		// The message ends later with a longer durationMs: the measured time of the run stays.
		component.updateContent(assistantMessage(started, ended, { durationMs: 60_000 }) as any, false);
		expect(host.render()[1]).toBe("  ├ Thought for 5.0s");
	});

	it("times each run of a message on its own while streaming", () => {
		const started = Date.now() - 10_000;
		const first = { type: "thinking", thinking: "first" };
		const second = { type: "thinking", thinking: "second" };
		const live = (content: unknown[]) => assistantMessage(started, content, { durationMs: undefined, stopReason: undefined });
		timeline.ingestAssistant(live([first]), true, started + 1_000);
		// The first run of a message counts from the message's timestamp; it ends when the read appears.
		timeline.ingestAssistant(live([first, call("r1", "read", { file_path: "/a" })]), true, started + 3_500);
		// The second run counts from when it first shows up, until the next block.
		timeline.ingestAssistant(live([first, call("r1", "read", { file_path: "/a" }), second]), true, started + 4_000);
		timeline.ingestAssistant(live([first, call("r1", "read", { file_path: "/a" }), second, call("r2", "read", { file_path: "/b" })]), true, started + 5_200);
		timeline.ingestAssistant(assistantMessage(started, [first, call("r1", "read", { file_path: "/a" }), second, call("r2", "read", { file_path: "/b" })], { durationMs: 9_000 }), false, started + 6_000);
		done("r1");
		done("r2");
		const host = view("read", "r1", { file_path: "/a" });
		expect(host.render()).toEqual([]);
		const { render } = assistantComponent(assistantMessage(started, [first, call("r1", "read", { file_path: "/a" }), second, call("r2", "read", { file_path: "/b" })], { durationMs: 9_000 }));
		expect(render()).toEqual(["", "  ├ Thought for 3.5s", "  ├ Read (/a) · 1 line", "  ├ Thought for 1.2s", "  └ Read (/b) · 1 line"]);
	});

	it("keeps pi's blank line between a list and the text it leads into", () => {
		const { render } = assistantComponent(assistantMessage(1_000, [
			{ type: "thinking", thinking: "one" },
			{ type: "text", text: " " },
			{ type: "thinking", thinking: "two" },
			{ type: "text", text: "answer" },
		]));
		// The second thought is drawn by the host; its own gap goes with it, the one before the text stays.
		// Two runs share one message's durationMs, which cannot be split: neither gets a time.
		expect(render()).toEqual(["", "  ├ Thought", "  └ Thought", "", "● answer"]);
		timeline.settle();
		expect(render()).toEqual(["", "  Thought for 2.0s ▸", "", "● answer"]);
	});

	it("leaves no stray blank line when the thought is folded into a segment above", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("r1", "read", { file_path: "/a" })]), false);
		const { render } = assistantComponent(assistantMessage(2_000, [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }]));
		expect(render()).toEqual(["", "● answer"]);
		expect(timeline.foldRole("msg:2000#0").kind).toBe("hidden");

		const failed = assistantComponent(assistantMessage(3_000, [{ type: "thinking", thinking: "x" }], { stopReason: "error", errorMessage: "boom" }));
		// A fresh segment: the lone thought draws itself.
		expect(failed.render()).toEqual(["", "  Thought for 2.0s", "", "  Error: boom"]);
	});

	it("collapses two blank lines into one around a hidden thought before an error note", () => {
		timeline.ingestAssistant(assistantMessage(1_000, [call("r1", "read", { file_path: "/a" })]), false);
		const { render } = assistantComponent(assistantMessage(2_000, [{ type: "thinking", thinking: "x" }], { stopReason: "error", errorMessage: "boom" }));
		expect(render()).toEqual(["", "  Error: boom"]);
	});

	it("draws a lone thought as before, with pi's blank line before the text", () => {
		const { render } = assistantComponent(assistantMessage(1_000, [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }], { durationMs: 3_000 }));
		expect(render()).toEqual(["", "  Thought for 3.0s", "", "● answer"]);
	});

	it("expands a collapsed segment back into the same list, and an item into its details in column 5", () => {
		const content = [
			{ type: "thinking", thinking: "## Plan\nfirst check the entry" },
			call("b1", "bash", { command: "npm test" }),
			call("r1", "read", { file_path: "/repo/a.ts" }),
		];
		timeline.ingestAssistant(assistantMessage(1_000, content), false);
		done("b1", "pass\nall good");
		done("r1", "line 1\nline 2");
		const host = view("read", "r1", { file_path: "/repo/a.ts" });
		// The thinking run hosts this segment: the member row never draws.
		expect(host.render()).toEqual([]);
		const { render } = assistantComponent(assistantMessage(1_000, content));
		const list = ["  ├ Thought for 2.0s", "  ├ Bash (npm test) · Done · 2 lines", "  └ Read (a.ts) · 2 lines"];
		expect(render()).toEqual(["", ...list]);

		timeline.settle();
		expect(render()).toEqual(["", "  Thought for 2.0s · Ran 1 command · Read 1 file ▸"]);
		const segment = timeline.segment("r1")!;
		timeline.toggleSegment(segment);
		expect(host.render()).toEqual([]);
		// Opened again: the summary with ▾ above the same list as during the run.
		expect(render()).toEqual(["", "  Thought for 2.0s · Ran 1 command · Read 1 file ▾", ...list]);

		timeline.toggleSegmentItem(segment, "b1");
		expect(render().slice(3)).toEqual([
			"  ├ Bash (npm test) · Done · 2 lines",
			"  │  $ npm test",
			"  │  pass",
			"  │  all good",
			"  └ Read (a.ts) · 2 lines",
		]);
		for (const line of render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("keeps the whole thought one click (or Ctrl+T) away from its timed line", () => {
		const content = [
			{ type: "thinking", thinking: "## Plan\nfirst check the entry\nthen the flags" },
			call("r1", "read", { file_path: "/a" }),
		];
		timeline.ingestAssistant(assistantMessage(1_000, content), false);
		done("r1");
		const { component, render } = assistantComponent(assistantMessage(1_000, content));
		expect(render()).toEqual(["", "  ├ Thought for 2.0s", "  └ Read (/a) · 1 line"]);

		// A click on the thought's line opens its full text in column 5, under the same line.
		(component as any).contentContainer.children.find((child: any) => child?.anchor === "msg:1000#0").handleMouse({ type: "click", button: "left", y: 0 });
		const opened = render();
		expect(opened[1]).toBe("  ├ Thought for 2.0s");
		expect(opened.slice(2, -1).join("\n")).toContain("first check the entry");
		expect(opened.slice(2, -1).join("\n")).toContain("then the flags");
		expect(opened.slice(2, -1).every((line) => line.startsWith("  │"))).toBe(true);
		expect(opened.at(-1)).toBe("  └ Read (/a) · 1 line");
		timeline.toggleSegmentItem(timeline.segment("r1")!, "msg:1000#0");
		expect(render()).toEqual(["", "  ├ Thought for 2.0s", "  └ Read (/a) · 1 line"]);

		// Ctrl+T shows every thought of the list in full, as it does for a standalone thought.
		timeline.thinkingDetails = true;
		expect(render().join("\n")).toContain("then the flags");
		timeline.thinkingDetails = false;

		// Collapsed and opened again, the item still opens into its text.
		timeline.settle();
		const segment = timeline.segment("r1")!;
		timeline.toggleSegment(segment);
		timeline.toggleSegmentItem(segment, "msg:1000#0");
		expect(render()[2]).toBe("  ├ Thought for 2.0s");
		expect(render().join("\n")).toContain("first check the entry");
	});

	it("times a resumed thought from its message: durationMs for a lone run, none for several", () => {
		timeline.seed([
			{ type: "message", message: { role: "user", content: "go", timestamp: 0 } },
			{ type: "message", message: assistantMessage(1_000, [{ type: "thinking", thinking: "one" }, call("r1", "read", { file_path: "/a" })], { durationMs: 4_500 }) },
			{ type: "message", message: { role: "toolResult", toolCallId: "r1", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1 } },
			{ type: "message", message: assistantMessage(2_000, [
				{ type: "thinking", thinking: "two" },
				call("r2", "read", { file_path: "/b" }),
				{ type: "thinking", thinking: "three" },
				call("r3", "read", { file_path: "/c" }),
			], { durationMs: 6_000 }) },
			{ type: "message", message: { role: "toolResult", toolCallId: "r2", content: [{ type: "text", text: "y" }], isError: false, timestamp: 2 } },
			{ type: "message", message: { role: "toolResult", toolCallId: "r3", content: [{ type: "text", text: "z" }], isError: false, timestamp: 2 } },
		], true, isManagedTool);
		const segment = timeline.segment("r1")!;
		timeline.toggleSegment(segment);
		const { render } = assistantComponent(assistantMessage(1_000, [{ type: "thinking", thinking: "one" }, call("r1", "read", { file_path: "/a" })], { durationMs: 4_500 }));
		expect(render()).toEqual([
			"",
			"  Thought for 10.5s · Read 3 files ▾",
			"  ├ Thought for 4.5s",
			"  ├ Read (/a) · 1 line",
			"  ├ Thought",
			"  ├ Read (/b) · 1 line",
			"  ├ Thought",
			"  └ Read (/c) · 1 line",
		]);
	});

	it("leaves thinking to pi and folds only tools with thinking 0", () => {
		config.thinking.lines = 0;
		timeline.setFoldPolicy(policy({ thinking: false }));
		const { render } = assistantComponent(assistantMessage(1_000, [
			{ type: "thinking", thinking: "native" },
			call("r1", "read", { file_path: "/a" }),
			call("r2", "read", { file_path: "/b" }),
		]));
		expect(render().join("\n")).toContain("native");
		expect(timeline.foldRole("r1").kind).toBe("host");
		expect(timeline.foldRole("msg:1000#0").kind).toBe("single");
	});

	it("maps regions to runs like pi when a hidden run has no region", () => {
		const message = assistantMessage(1_000, [
			{ type: "thinking", thinking: "first" },
			{ type: "text", text: "middle" },
			{ type: "thinking", thinking: "second" },
		], { stopReason: "stop" });
		const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "", 1);
		(component as any).thinkingVisibilityOverrides.set(0, true);
		component.updateContent(message as any, false);
		const slots = ((component as any).contentContainer.children as any[]).filter((child) => typeof child?.anchor === "string");
		expect(slots.map((slot) => slot.anchor)).toEqual(["msg:1000#1"]);
	});

	it("is the same layout as before with fold off", () => {
		timeline.setFoldPolicy(policy({ enabled: false }));
		const { render } = assistantComponent(assistantMessage(1_000, [{ type: "thinking", thinking: "plan" }, call("b1", "bash", { command: "npm test" })]));
		expect(render()).toEqual(["", "  Thought for 2.0s"]);
	});
});
