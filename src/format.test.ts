import { describe, expect, it } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

import { clipMiddle, formatDuration, tailThinkingRows, thoughtLabel } from "./format.js";

describe("format helpers", () => {
	it("clips the middle of a long line and keeps both ends", () => {
		const text = "rg --files --hidden --glob '!node_modules' src packages | sort | head -50";
		const clipped = clipMiddle(text, 40);
		expect(visibleWidth(clipped)).toBeLessThanOrEqual(40);
		expect(clipped.startsWith("rg --files")).toBe(true);
		expect(clipped.endsWith("head -50")).toBe(true);
		expect(clipped).toContain("…");
		expect(clipMiddle("short", 40)).toBe("short");
	});

	it("clips the middle of wide text within the budget", () => {
		for (const budget of [1, 2, 5, 9, 12]) {
			const clipped = clipMiddle("编译并运行全部单元测试然后输出覆盖率报告", budget);
			expect(visibleWidth(clipped)).toBeLessThanOrEqual(budget);
		}
	});

	it("formats durations compactly", () => {
		expect(formatDuration(500)).toBe("<1s");
		expect(formatDuration(12_000)).toBe("12s");
		expect(formatDuration(125_000)).toBe("2m 5s");
		expect(formatDuration(3_725_000)).toBe("1h 2m");
	});

	it("labels a finished thought with whole seconds, or not at all under a second", () => {
		expect(thoughtLabel(1_500)).toBe("Thought for 1.5s");
		expect(thoughtLabel(12_900)).toBe("Thought for 12.9s");
		expect(thoughtLabel(800)).toBe("Thought for 0.8s");
		expect(thoughtLabel(4_000)).toBe("Thought for 4.0s");
		expect(thoughtLabel(125_000)).toBe("Thought for 2m 5s");
		expect(thoughtLabel(50)).toBe("Thought");
		expect(thoughtLabel(undefined)).toBe("Thought");
	});

	it("returns only the newest thinking rows", () => {
		expect(tailThinkingRows("one\ntwo\n\n  three \nfour", 3, 40)).toEqual({
			rows: ["two", "three", "four"],
			hidden: true,
		});
		expect(tailThinkingRows("one\ntwo", 3, 40)).toEqual({ rows: ["one", "two"], hidden: false });
	});

	it("wraps a long paragraph into rows instead of clipping it", () => {
		const { rows, hidden } = tailThinkingRows("alpha beta gamma delta epsilon zeta eta theta", 3, 12);
		expect(rows).toEqual(["gamma delta", "epsilon zeta", "eta theta"]);
		expect(hidden).toBe(true);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
	});

	it("wraps wide characters by display width", () => {
		const { rows } = tailThinkingRows("这是最新的思考内容，还在继续往下写", 3, 10);
		expect(rows).toEqual(["思考内容，", "还在继续往", "下写"]);
	});

	// The point of wrapping: a full row stays put while text streams in, only the last one grows.
	it("keeps full rows unchanged as the thought streams in", () => {
		const english = Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ");
		const chinese = "我们先读一下配置文件再决定怎么改。".repeat(30);
		// A count large enough to see every row of the frame.
		const frame = (text: string) => tailThinkingRows(text, 10_000, 30).rows;
		for (const full of [english, chinese, `${english}\n${chinese}`]) {
			let previous = frame(full.slice(0, 100));
			for (let end = 101; end <= full.length; end += 3) {
				const next = frame(full.slice(0, end));
				// Only the last row may change: it grows, or its unfinished word moves down a row.
				expect(next.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
				previous = next;
			}
		}
	});

	it("keeps the rows stable when only the tail of a very long thought is wrapped", () => {
		const paragraph = (index: number) => `paragraph ${index} `.repeat(40).trim();
		const text = Array.from({ length: 200 }, (_, index) => paragraph(index)).join("\n");
		const before = tailThinkingRows(text, 3, 40);
		const after = tailThinkingRows(`${text} more`, 3, 40);
		expect(before.hidden).toBe(true);
		expect(after.rows.slice(0, 2)).toEqual(before.rows.slice(0, 2));
		expect(after.rows[2]).toBe(`${before.rows[2]} more`);
	});
});
