import { afterAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import { abortNoteText, summarizedInterrupts } from "./interrupt.js";
import { installThinkingPatch } from "./thinking.js";

const tokens: string[] = [];
const theme = {
	fg: (token: string, text: string) => {
		tokens.push(`${token}:${text}`);
		return text;
	},
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

function aborted(content: unknown[], errorMessage = "Operation aborted", timestamp = 1_000) {
	return {
		role: "assistant",
		content,
		api: "openai",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage,
		timestamp,
	};
}

// eslint-disable-next-line no-control-regex
const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\]133;[A-C]\x07/g, "").trimEnd();

function render(value: ReturnType<typeof aborted>): string[] {
	const component = new AssistantMessageComponent(value as any, false, getMarkdownTheme(), "Thinking...", 1);
	return component.render(60).map(plain);
}

describe("abort note", () => {
	initTheme("dark");
	const summarized = new Set<number>();
	const cleanup = installThinkingPatch({
		isEnabled: () => true,
		getLines: () => 3,
		getTheme: () => theme,
		getActiveTui: () => undefined,
		interrupt: { summaryFollows: (timestamp) => summarized.has(timestamp), getTheme: () => theme },
	});
	afterAll(() => cleanup());

	it("gives way, blank line included, to the `✻ Interrupted` summary below", () => {
		summarized.clear();
		summarized.add(1_000);
		expect(render(aborted([{ type: "text", text: "partial" }]))).toEqual(["", "● partial"]);
	});

	it("becomes a warning `Interrupted` in the content column without a summary", () => {
		summarized.clear();
		tokens.length = 0;
		expect(render(aborted([{ type: "text", text: "partial" }]))).toEqual(["", "● partial", "", "  Interrupted"]);
		expect(tokens).toContain("warning:Interrupted");
		expect(tokens.some((token) => token.startsWith("error:"))).toBe(false);
	});

	it("keeps an abort text that says more, dim under a summary", () => {
		summarized.clear();
		const value = aborted([{ type: "text", text: "partial" }], "Aborted after 2 retry attempts");
		expect(render(value)).toEqual(["", "● partial", "", "  Interrupted · Aborted after 2 retry attempts"]);
		summarized.add(1_000);
		expect(render(value)).toEqual(["", "● partial", "", "  Aborted after 2 retry attempts"]);
	});

	it("draws nothing at all for a summarized interrupt before any output", () => {
		summarized.clear();
		summarized.add(1_000);
		expect(render(aborted([]))).toEqual([]);
	});

	it("freezes the thinking header when a thought is interrupted", () => {
		summarized.clear();
		summarized.add(1_000);
		const rendered = render(aborted([{ type: "thinking", thinking: "let me see" }]));
		expect(rendered.some((line) => line.includes("Thinking…"))).toBe(false);
		expect(rendered.some((line) => line.trim().startsWith("Thought"))).toBe(true);
	});
});

describe("abortNoteText", () => {
	it("follows pi: tool calls carry the abort themselves, `Request was aborted` reads as the default", () => {
		expect(abortNoteText(aborted([{ type: "toolCall", id: "1", name: "bash", arguments: {} }]))).toBeUndefined();
		expect(abortNoteText(aborted([], "Request was aborted"))).toBe("Operation aborted");
		expect(abortNoteText(aborted([], ""))).toBe("Operation aborted");
		expect(abortNoteText({ ...aborted([]), stopReason: "stop" })).toBeUndefined();
	});
});

describe("summarizedInterrupts", () => {
	const user = { type: "message", message: { role: "user", timestamp: 1 } };
	const abortedAt = (timestamp: number) => ({ type: "message", message: { role: "assistant", stopReason: "aborted", timestamp } });
	const summary = (isAborted: boolean) => ({ type: "custom", customType: "better-tui-turn", data: { durationMs: 1, tools: 0, aborted: isAborted } });

	it("pairs aborted messages with the interrupted summary of their run", () => {
		const entries = [user, abortedAt(10), summary(true), user, abortedAt(20), user, abortedAt(30), summary(false)];
		// 20: its run never got a summary (summary off back then); 30: a run that went on and completed.
		expect([...summarizedInterrupts(entries, "better-tui-turn")]).toEqual([10]);
	});
});
