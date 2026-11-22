import { describe, expect, it } from "vitest";

import { ActivityTimeline, groupAction, groupCounts, groupDuration, groupSummary, hasVisibleText } from "./timeline.js";

const messageEntry = (message: unknown) => ({ type: "message", message });
const assistant = (content: unknown[], timestamp = 1000) => ({
	role: "assistant",
	content,
	timestamp,
});
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const toolResult = (id: string, name: string, text = "ok", isError = false) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError,
	timestamp: 2000,
	durationMs: 10,
});

describe("activity timeline", () => {
	it("groups adjacent read-only tools from a persisted session", () => {
		const timeline = new ActivityTimeline();
		timeline.seed([
			messageEntry({ role: "user", content: "hi", timestamp: 1 }),
			messageEntry(
				assistant([
					toolCall("a", "read", { file_path: "/repo/a.ts" }),
					toolCall("b", "read", { file_path: "/repo/b.ts" }),
					toolCall("c", "grep", { pattern: "foo", path: "src" }),
				]),
			),
			messageEntry(toolResult("a", "read", "one\ntwo")),
			messageEntry(toolResult("b", "read", "one")),
			messageEntry(toolResult("c", "grep", "src/a.ts:1: foo")),
		]);

		const groups = timeline.groupsList();
		expect(groups).toHaveLength(1);
		expect(groups[0]?.members).toHaveLength(3);
		expect(groupCounts(groups[0]!)).toEqual({ calls: 3, reads: 2, searches: 1, lists: 0 });
		expect(groupAction(groups[0]!)).toBe("Explored");
		expect(groupSummary(groups[0]!)).toBe("2 files, 1 search");
		expect(groupDuration(groups[0]!, 999_999)).toBe(1_000);
	});

	it("keeps a group across assistant turns without visible text", () => {
		const timeline = new ActivityTimeline();
		timeline.seed([
			messageEntry(assistant([toolCall("a", "read", { file_path: "/repo/a.ts" })])),
			messageEntry(toolResult("a", "read")),
			messageEntry(assistant([toolCall("b", "read", { file_path: "/repo/b.ts" })])),
			messageEntry(toolResult("b", "read")),
		]);
		expect(timeline.groupsList()).toHaveLength(1);
		expect(timeline.groupsList()[0]?.members).toHaveLength(2);
	});

	it("breaks a group on a non-read-only tool", () => {
		const timeline = new ActivityTimeline();
		timeline.seed([
			messageEntry(assistant([toolCall("a", "read", { file_path: "/repo/a.ts" })])),
			messageEntry(toolResult("a", "read")),
			messageEntry(assistant([toolCall("b", "edit", { file_path: "/repo/a.ts" })])),
			messageEntry(toolResult("b", "edit")),
			messageEntry(assistant([toolCall("c", "read", { file_path: "/repo/b.ts" })])),
			messageEntry(toolResult("c", "read")),
		]);

		expect(timeline.groupsList()).toHaveLength(2);
		expect(timeline.row("b")?.standalone).toBe(true);
	});

	it("breaks a group on visible assistant text", () => {
		const timeline = new ActivityTimeline();
		timeline.seed([
			messageEntry(assistant([toolCall("a", "read", { file_path: "/repo/a.ts" })])),
			messageEntry(toolResult("a", "read")),
			messageEntry(assistant([{ type: "text", text: "found it" }])),
			messageEntry(assistant([toolCall("b", "read", { file_path: "/repo/b.ts" })])),
			messageEntry(toolResult("b", "read")),
		]);

		expect(timeline.groupsList()).toHaveLength(2);
	});

	it("does not group unmanaged tools", () => {
		const timeline = new ActivityTimeline();
		timeline.seed([
			messageEntry(assistant([toolCall("a", "web_search", { query: "x" })])),
			messageEntry(assistant([toolCall("b", "read", { file_path: "/repo/a.ts" })])),
			messageEntry(toolResult("b", "read")),
		]);

		expect(timeline.row("a")).toBeUndefined();
		expect(timeline.groupsList()).toHaveLength(1);
	});

	it("detects visible assistant text", () => {
		expect(hasVisibleText({ content: [{ type: "text", text: "hi" }] })).toBe(true);
		expect(hasVisibleText({ content: [{ type: "text", text: "  " }] })).toBe(false);
	});
});
