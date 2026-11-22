import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { ActivityTimeline } from "./timeline.js";
import { createToolRenderers } from "./tool-row.js";
import { DEFAULT_CONFIG } from "./config.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

function context(timeline: ActivityTimeline, toolCallId: string, args: Record<string, unknown>) {
	return {
		args,
		toolCallId,
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: true,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		keyHint: () => "",
		keyText: () => "",
	} as any;
}

function renderers(timeline: ActivityTimeline, name: string) {
	return createToolRenderers(name, undefined, {
		timeline,
		getConfig: () => DEFAULT_CONFIG,
		getTheme: () => theme,
	});
}

describe("tool row rendering", () => {
	it("treats a partial result as running output, not as the end of the call", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "bash");
		const args = { command: "npm run build" };
		const ctx = context(timeline, "bash-p", args);
		renderer.renderCall?.(args, theme, ctx);
		renderer.renderResult?.({ content: [{ type: "text", text: "compiling…" }], details: undefined }, { expanded: false, isPartial: true }, theme, ctx);
		const row = timeline.row("bash-p")!;
		expect(row.endedAt).toBeUndefined();
		expect(row.result).toBeUndefined();
		expect(row.partialText).toBe("compiling…");

		renderer.renderResult?.({ content: [{ type: "text", text: "done" }], details: undefined }, { expanded: false, isPartial: false }, theme, { ...ctx, isPartial: false });
		expect(timeline.row("bash-p")!.endedAt).toBeDefined();
	});

	it("takes the error flag from the render context", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "bash");
		const args = { command: "npm test" };
		const ctx = { ...context(timeline, "bash-e", args), isPartial: false, isError: true };
		renderer.renderCall?.(args, theme, ctx);
		renderer.renderResult?.({ content: [{ type: "text", text: "1 failed" }], details: undefined }, { expanded: false, isPartial: false }, theme, ctx);
		expect(timeline.row("bash-e")!.result?.isError).toBe(true);
	});

	it("renders a standalone command as one compact row", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "bash");
		const component = renderer.renderCall?.({ command: "npm test" }, theme, context(timeline, "bash-1", { command: "npm test" }));
		const lines = component?.render(80) ?? [];
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Bash");
		expect(lines[0]).toContain("npm test");
		// The marker is the gutter's column 0 even though pi passes outputPad: 1.
		expect(lines[0]!.startsWith("● Bash")).toBe(true);
	});

	it("shows the description collapsed and the full command when expanded", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "bash");
		const command = `npm run build && ${"npm test -- --reporter=verbose ".repeat(4)}\necho done`;
		const args = { command, description: "构建并运行测试" };
		const view = renderer.renderCall?.(args, theme, context(timeline, "bash-2", args));
		timeline.setResult("bash-2", { content: [{ type: "text", text: "ok" }], isError: false }, Date.now());

		const collapsed = view?.render(80) ?? [];
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("(构建并运行测试)");
		expect(collapsed[0]).not.toContain("npm run build");

		timeline.toggleRow(timeline.row("bash-2")!);
		const expanded = view?.render(60) ?? [];
		expect(expanded[1]).toContain("$ npm run build");
		expect(expanded.some((line) => line.trim() === "echo done")).toBe(true);
		expect(expanded.at(-1)?.trim()).toBe("ok");
		for (const line of expanded) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("merges consecutive read-only tools into one group row", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "read");
		const firstArgs = { file_path: "/repo/a.ts" };
		const secondArgs = { file_path: "/repo/b.ts" };
		const first = renderer.renderCall?.(firstArgs, theme, context(timeline, "read-1", firstArgs));
		renderer.renderCall?.(secondArgs, theme, context(timeline, "read-2", secondArgs));
		timeline.setResult("read-1", { content: [{ type: "text", text: "one" }], isError: false }, 2_000);
		timeline.setResult("read-2", { content: [{ type: "text", text: "two" }], isError: false }, 2_100);

		const lines = first?.render(80) ?? [];
		expect(lines[0]).toContain("Read 2 files");
		expect(lines.length).toBe(1);
	});

	it("draws a group header as a dim process line with no marker", () => {
		const timeline = new ActivityTimeline();
		const tokens = new Map<string, string[]>();
		const tagged = {
			...theme,
			fg: (token: string, text: string) => {
				tokens.set(token, [...(tokens.get(token) ?? []), text]);
				return text;
			},
		} as unknown as Theme;
		const renderer = createToolRenderers("read", undefined, {
			timeline,
			getConfig: () => DEFAULT_CONFIG,
			getTheme: () => tagged,
		});
		const firstArgs = { file_path: "/repo/a.ts" };
		const grepArgs = { pattern: "x", path: "/repo" };
		const first = renderer.renderCall?.(firstArgs, tagged, context(timeline, "read-1", firstArgs));
		createToolRenderers("grep", undefined, { timeline, getConfig: () => DEFAULT_CONFIG, getTheme: () => tagged })
			.renderCall?.(grepArgs, tagged, context(timeline, "grep-1", grepArgs));

		const running = first?.render(80) ?? [];
		expect(running[0]!.startsWith("  Exploring 1 file, 1 search")).toBe(true);
		// The children keep their rails in the content column.
		expect(running.slice(1).every((line) => /^ {2}[├└] /.test(line))).toBe(true);

		timeline.setResult("read-1", { content: [{ type: "text", text: "one" }], isError: false }, 2_000);
		timeline.setResult("grep-1", { content: [{ type: "text", text: "a.ts:1:x" }], isError: false }, 2_100);
		tokens.clear();
		const done = first?.render(80) ?? [];
		expect(done).toHaveLength(1);
		expect(done[0]!.startsWith("  Explored 1 file, 1 search")).toBe(true);
		expect(done[0]!.endsWith(" ▸")).toBe(true);
		expect(tokens.get("dim")).toContain("Explored 1 file, 1 search");
		expect(tokens.get("dim")).toContain(" ▸");
		expect(tokens.has("text")).toBe(false);
		expect(tokens.has("success")).toBe(false);
		expect(tokens.has("accent")).toBe(false);
	});

	it("puts ! or × in column 0 of a group header only when members failed", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "read");
		const firstArgs = { file_path: "/repo/a.ts" };
		const secondArgs = { file_path: "/repo/b.ts" };
		const first = renderer.renderCall?.(firstArgs, theme, context(timeline, "read-1", firstArgs));
		renderer.renderCall?.(secondArgs, theme, context(timeline, "read-2", secondArgs));
		timeline.setResult("read-1", { content: [{ type: "text", text: "one" }], isError: false }, 2_000);
		timeline.setResult("read-2", { content: [{ type: "text", text: "ENOENT" }], isError: true }, 2_100);
		const partial = first?.render(80) ?? [];
		expect(partial[0]!.startsWith("! Read 2 files · 1 failed")).toBe(true);

		const other = new ActivityTimeline();
		const failing = renderers(other, "read");
		const a = failing.renderCall?.(firstArgs, theme, context(other, "read-1", firstArgs));
		failing.renderCall?.(secondArgs, theme, context(other, "read-2", secondArgs));
		other.setResult("read-1", { content: [{ type: "text", text: "EACCES" }], isError: true }, 2_000);
		other.setResult("read-2", { content: [{ type: "text", text: "ENOENT" }], isError: true }, 2_100);
		expect((a?.render(80) ?? [])[0]!.startsWith("× Read 2 files · 2 failed")).toBe(true);
	});

	it("counts interrupted members apart from failures, with no marker", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "read");
		const firstArgs = { file_path: "/repo/a.ts" };
		const secondArgs = { file_path: "/repo/b.ts" };
		const first = renderer.renderCall?.(firstArgs, theme, context(timeline, "read-1", firstArgs));
		renderer.renderCall?.(secondArgs, theme, context(timeline, "read-2", secondArgs));
		timeline.setResult("read-1", { content: [{ type: "text", text: "one" }], isError: false }, 2_000);
		timeline.setResult("read-2", { content: [{ type: "text", text: "Operation aborted" }], isError: true }, 2_100);
		const lines = first?.render(80) ?? [];
		expect(lines[0]).toMatch(/^ {2}Read 2 files · 1 interrupted/);
		expect(lines[0]).not.toContain("failed");
		// Collapsed: an interrupted member is not pulled out like a failure is.
		expect(lines).toHaveLength(1);
	});

	it("draws an interrupted command with a warning ● and no error detail", () => {
		const timeline = new ActivityTimeline();
		const tokens: string[] = [];
		const tracking = {
			...theme,
			fg: (token: string, text: string) => {
				tokens.push(`${token}:${text}`);
				return text;
			},
		} as unknown as Theme;
		const renderer = createToolRenderers("bash", undefined, {
			timeline,
			getConfig: () => DEFAULT_CONFIG,
			getTheme: () => tracking,
		});
		const args = { command: "npm test" };
		const ctx = { ...context(timeline, "bash-i", args), isPartial: false, isError: true };
		const component = renderer.renderCall?.(args, tracking, ctx);
		renderer.renderResult?.(
			{ content: [{ type: "text", text: "running 12 tests\n\nCommand aborted" }], details: undefined },
			{ expanded: false, isPartial: false },
			tracking,
			ctx,
		);
		tokens.length = 0;
		const lines = component?.render(80) ?? [];
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^● Bash \(npm test\) · interrupted · /);
		expect(tokens).toContain("warning:●");
		expect(tokens).toContain("warning: · interrupted");
		expect(tokens.some((token) => token.startsWith("error:"))).toBe(false);
	});

	it("draws a SKILL.md read as its own skill row between read groups", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "read");
		const before = { file_path: "/repo/a.ts" };
		const skill = { file_path: "C:\\Users\\me\\.pi\\skills\\code-review\\SKILL.md" };
		const after = { file_path: "/repo/b.ts" };
		const first = renderer.renderCall?.(before, theme, context(timeline, "read-1", before));
		const skillView = renderer.renderCall?.(skill, theme, context(timeline, "read-2", skill));
		const last = renderer.renderCall?.(after, theme, context(timeline, "read-3", after));
		for (const id of ["read-1", "read-2", "read-3"]) {
			timeline.setResult(id, { content: [{ type: "text", text: "body" }], isError: false }, Date.now());
		}

		expect(timeline.row("read-2")?.group).toBeUndefined();
		expect(timeline.row("read-1")?.group).not.toBe(timeline.row("read-3")?.group);
		expect(skillView?.render(80)).toEqual(["● [Skill] (code-review) ▸"]);
		expect(first?.render(80)[0]).toContain("Read");
		expect(last?.render(80)[0]).toContain("Read");
	});

	it("moves a read out of its group once streamed arguments show a SKILL.md path", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "read");
		const before = { file_path: "/repo/a.ts" };
		renderer.renderCall?.(before, theme, context(timeline, "read-1", before));
		const partial = { file_path: "/skills/code-review/SK" };
		renderer.renderCall?.(partial, theme, context(timeline, "read-2", partial));
		expect(timeline.row("read-2")?.group?.members).toHaveLength(2);

		const full = { file_path: "/skills/code-review/SKILL.md" };
		const view = renderer.renderCall?.(full, theme, context(timeline, "read-2", full));
		expect(timeline.row("read-2")?.group).toBeUndefined();
		expect(timeline.row("read-1")?.group?.members).toHaveLength(1);
		expect(view?.render(80)).toEqual(["● [Skill] (code-review) ▸"]);

		const next = { file_path: "/repo/c.ts" };
		renderer.renderCall?.(next, theme, context(timeline, "read-3", next));
		expect(timeline.row("read-3")?.group).not.toBe(timeline.row("read-1")?.group);
	});

	it("shows the newest two children while a group is running", () => {
		const timeline = new ActivityTimeline();
		const renderer = renderers(timeline, "read");
		for (const id of ["read-1", "read-2", "read-3"]) {
			const args = { file_path: `/repo/${id}.ts` };
			renderer.renderCall?.(args, theme, context(timeline, id, args));
		}
		const first = timeline.row("read-1")!;
		const view = renderer.renderCall?.({ file_path: "/repo/read-1.ts" }, theme, context(timeline, "read-1", { file_path: "/repo/read-1.ts" }));
		const lines = view?.render(80) ?? [];
		expect(lines[0]).toContain("Reading 3 files");
		expect(lines.length).toBe(3);
		expect(first.group?.members).toHaveLength(3);
	});
});
