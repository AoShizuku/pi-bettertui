import { describe, expect, it } from "vitest";

import type { FoldPolicy } from "./segment.js";
import { ActivityTimeline } from "./timeline.js";
import { isManagedTool } from "./tool-summary.js";

const POLICY: FoldPolicy = { enabled: true, minItems: 2, thinking: true, manage: isManagedTool };

type Block = Record<string, unknown>;

const thinking = (text: string): Block => ({ type: "thinking", thinking: text });
const text = (value: string): Block => ({ type: "text", text: value });
const call = (id: string, name: string, args: Record<string, unknown>): Block => ({ type: "toolCall", id, name, arguments: args });
const assistant = (timestamp: number, content: Block[], extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content,
	timestamp,
	durationMs: 2_000,
	stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	...extra,
});
const result = (id: string, isError = false, output = "ok") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "x",
	content: [{ type: "text", text: output }],
	isError,
	timestamp: 0,
});
const user = (value: string) => ({ role: "user", content: value, timestamp: 0 });
const entry = (message: unknown) => ({ type: "message", message });

/**
 * Every content snapshot pi hands `updateContent` while a message streams: each block appears
 * empty, grows in a few steps, and stays complete once the next one starts.
 */
function snapshots(content: Block[]): Block[][] {
	const out: Block[][] = [];
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		const done = content.slice(0, index);
		const steps: Block[] = [];
		if (block.type === "thinking" || block.type === "text") {
			const key = block.type === "thinking" ? "thinking" : "text";
			const full = String(block[key]);
			for (const cut of [0, Math.ceil(full.length / 2), full.length]) steps.push({ ...block, [key]: full.slice(0, cut) });
		} else if (block.type === "toolCall") {
			const args = block.arguments as Record<string, unknown>;
			const command = typeof args.command === "string" ? args.command : undefined;
			const path = typeof args.file_path === "string" ? args.file_path : undefined;
			steps.push({ ...block, arguments: {} });
			if (command) for (const cut of [3, Math.ceil(command.length / 2), command.length - 1]) steps.push({ ...block, arguments: { ...args, command: command.slice(0, cut) } });
			if (path) steps.push({ ...block, arguments: { ...args, file_path: path.slice(0, path.length - 3) } });
			steps.push(block);
		} else {
			steps.push(block);
		}
		for (const step of steps) out.push([...done, step]);
	}
	return out;
}

/** Feed a session the way the live events do; returns the timeline. */
function stream(entries: Array<{ type: string; message?: any }>, policy = POLICY, settleAtEnd = true): ActivityTimeline {
	const timeline = new ActivityTimeline();
	timeline.setFoldPolicy(policy);
	for (const item of entries) {
		if (item.type !== "message") {
			// The turn summary entry stands for agent_settled.
			timeline.settle();
			continue;
		}
		const message = item.message;
		if (message.role === "assistant") {
			for (const content of snapshots(message.content)) {
				const partial = { ...message, content, durationMs: undefined, stopReason: undefined };
				timeline.ingestAssistant(partial, true);
				// Ingest is idempotent: pi's patch and the extension event both call it.
				timeline.ingestAssistant(partial, true);
			}
			timeline.ingestAssistant(message, false);
			timeline.onMessage(message);
			continue;
		}
		if (message.role === "toolResult") {
			timeline.end(message.toolCallId, message, 1);
			continue;
		}
		timeline.onMessage(message);
	}
	// The last run settles too; a seed only ever sees finished runs.
	if (settleAtEnd) timeline.settle();
	return timeline;
}

function seeded(entries: unknown[], policy = POLICY): ActivityTimeline {
	const timeline = new ActivityTimeline();
	timeline.setFoldPolicy(policy);
	timeline.seed(entries, true, policy.manage);
	return timeline;
}

/** A realistic reconnaissance run: interleaved thinking and commands, text, an edit, more reads. */
const SESSION = [
	entry(user("fix the parser")),
	entry(assistant(1_000, [thinking("look for parseArgs first"), call("b1", "bash", { command: "rg -n parseArgs src" })])),
	entry(result("b1")),
	entry(assistant(2_000, [thinking("now read it"), call("r1", "read", { file_path: "/repo/src/args.ts" }), call("r2", "read", { file_path: "/repo/src/cli.ts" })])),
	entry(result("r1")),
	entry(result("r2", true, "ENOENT")),
	entry(assistant(3_000, [thinking("checking build"), call("b2", "bash", { command: "npm run build", description: "build" }), text("The flag check is split; I will merge it."), thinking("edit now"), call("e1", "edit", { path: "/repo/src/args.ts" })])),
	entry(result("b2")),
	entry(result("e1")),
	entry(assistant(4_000, [thinking("verify"), call("b3", "bash", { command: "npm test" }), call("b4", "bash", { command: "echo done > status.txt" }), call("g1", "grep", { pattern: "flag", path: "src" })])),
	entry(result("b3")),
	entry(result("b4")),
	entry(result("g1")),
	entry(assistant(5_000, [call("s1", "read", { file_path: "/skills/demo/SKILL.md" }), call("l1", "ls", { path: "." }), call("rm1", "bash", { command: "rm -rf dist" })])),
	entry(result("s1")),
	entry(result("l1")),
	entry(result("rm1")),
	{ type: "custom", customType: "better-tui-turn", data: {} },
	entry(user("thanks")),
	entry(assistant(6_000, [thinking("short"), text("Done.")])),
];

describe("fold segments", () => {
	it("builds the same segments from streaming snapshots as from a seed", () => {
		const live = stream(SESSION as any);
		const resumed = seeded(SESSION);
		expect(live.foldSnapshot()).toEqual(resumed.foldSnapshot());
		// Every run in the history has ended, so every segment is collapsed on both paths.
		const done = { closed: true, collapsed: true };
		expect(resumed.foldSnapshot()).toEqual([
			// Across three messages, until the text in the third one.
			{ host: "msg:1000#0", items: ["msg:1000#0", "b1", "msg:2000#0", "r1", "r2", "msg:3000#0", "b2"], ...done },
			// After the text: a lone thought before the edit.
			{ host: "msg:3000#1", items: ["msg:3000#1"], ...done },
			// The redirect makes b4 a change; it closes the segment and the grep starts a new one.
			{ host: "msg:4000#0", items: ["msg:4000#0", "b3"], ...done },
			{ host: "g1", items: ["g1"], ...done },
			// The SKILL.md read is drawn on its own; rm closes the ls segment.
			{ host: "l1", items: ["l1"], ...done },
			{ host: "msg:6000#0", items: ["msg:6000#0"], ...done },
		]);
		// Both paths agree on rows too: provisional members got rows while streaming.
		for (const id of ["b1", "r1", "r2", "b2", "e1", "b3", "b4", "g1", "s1", "l1", "rm1"]) {
			expect(live.row(id), id).toBeDefined();
		}
	});

	it("keeps assigning blocks to the same anchors when an old message is updated again", () => {
		const timeline = stream(SESSION as any);
		const before = timeline.foldSnapshot();
		// Ctrl+T or an invalidate replays updateContent on every assistant component.
		for (const item of SESSION as any[]) if (item.type === "message" && item.message.role === "assistant") timeline.ingestAssistant(item.message, false);
		expect(timeline.foldSnapshot()).toEqual(before);
	});

	it("does not append a message older than the newest one it has seen", () => {
		const timeline = new ActivityTimeline();
		timeline.setFoldPolicy(POLICY);
		timeline.ingestAssistant(assistant(2_000, [call("a", "read", { file_path: "/a" })]), false);
		timeline.ingestAssistant(assistant(1_000, [call("old", "read", { file_path: "/old" })]), false);
		expect(timeline.foldSnapshot()).toEqual([{ host: "a", items: ["a"], closed: false, collapsed: false }]);
	});

	it("keeps segments closed at a boundary drawn as lists until the run settles", () => {
		// The first run of SESSION, stopped right before its turn summary entry.
		const runEnd = SESSION.findIndex((item: any) => item.type === "custom");
		const live = stream(SESSION.slice(0, runEnd) as any, POLICY, false);
		const segments = live.foldSnapshot();
		expect(segments.length).toBeGreaterThan(2);
		// Text, the edit and the changing commands closed them, but nothing collapsed mid-run.
		expect(segments.every((segment) => segment.closed && !segment.collapsed)).toBe(true);

		// A segment the user opened an item of during the run collapses all the same.
		const first = live.segment("b1")!;
		live.toggleSegmentItem(first, "b1");
		live.settle();
		expect(live.foldSnapshot().every((segment) => segment.collapsed)).toBe(true);
		expect(first.expanded).toBe(false);
		expect(first.expandedItems.size).toBe(0);

		// The next run starts new lists; the segments of the run before stay collapsed.
		live.ingestAssistant(assistant(9_000, [call("n1", "read", { file_path: "/n" })]), false);
		expect(live.segment("n1")?.collapsed).toBe(false);
		expect(first.collapsed).toBe(true);
	});

	it("collapses on resume what streaming collapsed at agent_settled, even a run cut off mid-way", () => {
		const runEnd = SESSION.findIndex((item: any) => item.type === "custom");
		// A session whose last run never settled (the process died while a command ran).
		const cut = [...SESSION.slice(0, runEnd)];
		const resumed = seeded(cut);
		expect(resumed.foldSnapshot().every((segment) => segment.collapsed)).toBe(true);
		const live = stream(cut as any);
		expect(live.foldSnapshot()).toEqual(resumed.foldSnapshot());
	});

	it("folds only from the configured number of items", () => {
		const timeline = seeded([
			entry(assistant(1_000, [call("r1", "read", { file_path: "/a" })])),
			entry(result("r1")),
			entry(assistant(2_000, [text("next")])),
			entry(assistant(3_000, [call("r2", "read", { file_path: "/a" }), call("r3", "read", { file_path: "/b" })])),
		]);
		expect(timeline.foldRole("r1").kind).toBe("single");
		expect(timeline.foldRole("r2").kind).toBe("host");
		expect(timeline.foldRole("r3").kind).toBe("hidden");

		const strict = seeded([entry(assistant(3_000, [call("r2", "read", { file_path: "/a" }), call("r3", "read", { file_path: "/b" })]))], { ...POLICY, minItems: 3 });
		expect(strict.foldRole("r2").kind).toBe("single");
		expect(strict.foldRole("r3").kind).toBe("single");
	});

	it("treats thinking as a text boundary with thinking 0", () => {
		const timeline = seeded([
			entry(assistant(1_000, [call("r1", "read", { file_path: "/a" }), thinking("hmm"), call("r2", "read", { file_path: "/b" })])),
		], { ...POLICY, thinking: false });
		expect(timeline.foldSnapshot()).toEqual([
			{ host: "r1", items: ["r1"], closed: true, collapsed: true },
			{ host: "r2", items: ["r2"], closed: true, collapsed: true },
		]);
	});

	it("closes a segment at a user message, an error, compaction and unmanaged tools", () => {
		const timeline = seeded([
			entry(assistant(1_000, [call("r1", "read", { file_path: "/a" })])),
			entry(user("stop")),
			entry(assistant(2_000, [call("r2", "read", { file_path: "/b" })], { stopReason: "error" })),
			entry(assistant(3_000, [call("r3", "read", { file_path: "/c" })])),
			{ type: "compaction" },
			entry(assistant(4_000, [call("r4", "read", { file_path: "/d" }), call("m1", "mcp_lookup", {}), call("r5", "read", { file_path: "/e" })])),
		]);
		expect(timeline.foldSnapshot().map((segment) => segment.items)).toEqual([["r1"], ["r2"], ["r3"], ["r4"], ["r5"]]);
	});

	it("does not close a segment for extension state entries between two messages", () => {
		const timeline = seeded([
			entry(assistant(1_000, [call("r1", "read", { file_path: "/a" })])),
			{ type: "custom", customType: "some-extension-state", data: {} },
			{ type: "model_change" },
			entry(assistant(2_000, [call("r2", "read", { file_path: "/b" })])),
		]);
		expect(timeline.foldSnapshot().map((segment) => segment.items)).toEqual([["r1", "r2"]]);
	});

	it("moves a streamed command out once its arguments show a change, and leaves the rest in place", () => {
		const timeline = new ActivityTimeline();
		timeline.setFoldPolicy(POLICY);
		timeline.ingestAssistant(assistant(1_000, [thinking("plan"), call("r1", "read", { file_path: "/a" })]), false);
		const partial = assistant(2_000, [call("b1", "bash", { command: "echo x > out" })]);
		timeline.ingestAssistant({ ...partial, stopReason: undefined }, true);
		expect(timeline.foldSnapshot()).toEqual([{ host: "msg:1000#0", items: ["msg:1000#0", "r1", "b1"], closed: false, collapsed: false }]);
		expect(timeline.foldRole("b1").kind).toBe("hidden");

		timeline.ingestAssistant(partial, false);
		expect(timeline.foldSnapshot()).toEqual([{ host: "msg:1000#0", items: ["msg:1000#0", "r1"], closed: true, collapsed: false }]);
		expect(timeline.foldRole("b1").kind).toBe("single");

		// The next read starts a new segment instead of joining the one above the change.
		timeline.ingestAssistant(assistant(3_000, [call("r2", "read", { file_path: "/b" })]), false);
		expect(timeline.segment("r2")?.host).toBe("r2");
	});

	it("drops a segment that only held the command that turned out to be a change", () => {
		const timeline = new ActivityTimeline();
		timeline.setFoldPolicy(POLICY);
		const message = assistant(1_000, [call("b1", "bash", { command: "git commit -m wip" })]);
		timeline.ingestAssistant({ ...message, content: [call("b1", "bash", { command: "git co" })] }, true);
		expect(timeline.foldSnapshot()).toHaveLength(1);
		timeline.ingestAssistant(message, false);
		expect(timeline.foldSnapshot()).toEqual([]);
	});

	it("is inert with fold off: no segments, read-only groups as before", () => {
		const timeline = new ActivityTimeline();
		timeline.seed([entry(assistant(1_000, [thinking("x"), call("r1", "read", { file_path: "/a" }), call("r2", "read", { file_path: "/b" })]))]);
		expect(timeline.foldSnapshot()).toEqual([]);
		expect(timeline.row("r1")?.group?.members).toHaveLength(2);
		expect(timeline.foldRole("r1").kind).toBe("single");
	});

	it("sums thinking time once per message and keeps tense per kind", () => {
		const timeline = new ActivityTimeline();
		timeline.setFoldPolicy(POLICY);
		timeline.ingestAssistant(assistant(1_000, [thinking("a"), text(" "), thinking("b"), call("b1", "bash", { command: "npm test" })], { durationMs: 3_000 }), false);
		timeline.ingestAssistant(assistant(10_000, [thinking("c"), call("r1", "read", { file_path: "/a" })], { durationMs: 2_000 }), false);
		const segment = timeline.segment("b1")!;
		const stats = timeline.segmentStats(segment);
		expect(stats.thinking).toEqual({ count: 3, ms: 5_000, active: false });
		expect(stats.commands).toEqual({ count: 1, active: true });
		expect(stats.exploreActive).toBe(true);

		timeline.end("b1", result("b1"), 20_000);
		timeline.end("r1", result("r1", true), 20_000);
		const done = timeline.segmentStats(segment);
		expect(done.commands.active).toBe(false);
		expect(done.failed).toBe(1);

		// A streaming message counts up from its timestamp until its duration is known.
		timeline.ingestAssistant({ ...assistant(30_000, [thinking("d")]), durationMs: undefined }, true);
		const live = timeline.segmentStats(segment, 34_000);
		expect(live.thinking.active).toBe(true);
		expect(live.thinking.ms).toBe(9_000);
	});
});
