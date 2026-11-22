import { describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { collectThinkingRuns, hasAnswer, ThinkingView } from "./thinking.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

// eslint-disable-next-line no-control-regex
const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");

describe("thinking presentation", () => {
	initTheme("dark");

	it("groups adjacent thinking blocks into one run", () => {
		const runs = collectThinkingRuns({
			content: [
				{ type: "thinking", thinking: "one" },
				{ type: "thinking", thinking: "two" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "three" },
			],
		});
		expect(runs).toEqual(["one\n\ntwo", "three"]);
	});

	it("detects when an answer has started", () => {
		expect(hasAnswer({ content: [{ type: "text", text: "hello" }] })).toBe(true);
		expect(hasAnswer({ content: [{ type: "toolCall", id: "a", name: "read" }] })).toBe(true);
		expect(hasAnswer({ content: [{ type: "thinking", thinking: "hmm" }] })).toBe(false);
	});

	it("reserves exactly three preview rows while streaming", () => {
		const view = new ThinkingView({
			text: "one\ntwo\nthree\nfour\nfive",
			streaming: true,
			expanded: false,
			startedAt: Date.now() - 12_000,
			durationMs: 12_000,
			pad: 0,
			getTheme: () => theme,
			lineCount: 3,
		});
		const lines = view.render(80);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("Thinking");
		expect(lines.slice(1).join("\n")).toContain("five");
	});

	it("collapses a finished thought to one line", () => {
		const view = new ThinkingView({
			text: "one\ntwo",
			streaming: false,
			expanded: false,
			startedAt: 0,
			durationMs: 18_000,
			pad: 0,
			getTheme: () => theme,
			lineCount: 3,
		});
		const lines = view.render(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Thought for 18.0s");
	});

	it("draws the header without a marker, dim, from column 2", () => {
		const tokens: string[] = [];
		const tagged = {
			...theme,
			fg: (token: string, text: string) => {
				tokens.push(token);
				return `<${token}>${text}</${token}>`;
			},
		} as unknown as Theme;
		const done = new ThinkingView({
			text: "one",
			streaming: false,
			expanded: false,
			startedAt: 0,
			durationMs: 18_000,
			pad: 0,
			getTheme: () => tagged,
			lineCount: 3,
		});
		expect(done.render(80)).toEqual(["  <dim>Thought for 18.0s</dim>"]);

		const live = new ThinkingView({
			text: "one",
			streaming: true,
			expanded: false,
			startedAt: Date.now() - 12_000,
			durationMs: 0,
			pad: 0,
			getTheme: () => tagged,
			lineCount: 3,
		});
		// The elapsed time is part of the same dim run.
		expect(live.render(80)[0]).toMatch(/^ {2}<dim>Thinking… 1[23]s<\/dim>$/);
		expect(tokens).not.toContain("accent");
	});

	it("indents the streaming tail and the expanded thought to column 4", () => {
		const tail = new ThinkingView({
			text: "one\ntwo\nthree\nfour",
			streaming: true,
			expanded: false,
			startedAt: Date.now(),
			durationMs: 0,
			pad: 0,
			getTheme: () => theme,
			lineCount: 3,
		}).render(40);
		for (const line of tail.slice(1)) {
			expect(line[4]).not.toBe(" ");
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
		// The "… " hangs in front of the body column, under the header.
		expect(tail.slice(1)).toEqual(["  … two", "    three", "    four"]);
	});

	it("wraps a long streaming line into rows that fill the width", () => {
		const text = "The user wants the thinking tail to scroll up row by row instead of sliding sideways.";
		const tail = new ThinkingView({
			text,
			streaming: true,
			expanded: false,
			startedAt: Date.now(),
			durationMs: 0,
			pad: 0,
			getTheme: () => theme,
			lineCount: 3,
		}).render(30);
		expect(tail.slice(1)).toEqual(["  … thinking tail to scroll up", "    row by row instead of", "    sliding sideways."]);
		for (const line of tail) expect(visibleWidth(line)).toBeLessThanOrEqual(30);

		const expanded = new ThinkingView({
			text: "first paragraph\n\nsecond paragraph",
			streaming: false,
			expanded: true,
			startedAt: 0,
			durationMs: 2_000,
			pad: 0,
			getTheme: () => theme,
			lineCount: 3,
		}).render(40);
		expect(expanded[0]).toBe("  Thought for 2.0s");
		const body = expanded.slice(1).map(plain).filter((line) => line.trim() !== "");
		expect(body.map((line) => line.trimEnd())).toEqual(["    first paragraph", "    second paragraph"]);
	});
});
