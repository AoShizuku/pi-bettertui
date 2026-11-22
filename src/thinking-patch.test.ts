import { afterAll, describe, expect, it } from "vitest";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

import {
	installLiveThinkingPatch,
	installThinkingPatch,
	isSpacer,
	ThinkingView,
	uninstallThinkingPatches,
} from "./thinking.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

function message(content: unknown[], durationMs?: number) {
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
		stopReason: "stop",
		timestamp: Date.now(),
		durationMs,
	};
}

function assistantComponent(value: ReturnType<typeof message>, outputPad = 0) {
	return new AssistantMessageComponent(
		value as any,
		false,
		getMarkdownTheme(),
		"Thinking...",
		outputPad,
	);
}

// eslint-disable-next-line no-control-regex
const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\]133;[A-C]\x07/g, "");

describe("isSpacer", () => {
	it("recognises pi-tui's Spacer by shape and nothing else that renders blank lines", () => {
		expect(isSpacer(new Spacer(1))).toBe(true);
		expect(isSpacer(new Spacer(0))).toBe(false);
		expect(isSpacer(new Text("", 0, 0))).toBe(false);
		expect(isSpacer(new Container())).toBe(false);
		expect(isSpacer({ lines: 1, render: () => [""] })).toBe(false);
		expect(isSpacer({ lines: 1, setLines() {}, render: () => ["x"] })).toBe(false);
		expect(isSpacer({ lines: 1, setLines() {}, render: () => { throw new Error("boom"); } })).toBe(false);
	});
});

describe("thinking patch", () => {
	initTheme("dark");
	let lines = 3;
	const cleanup = installThinkingPatch({
		isEnabled: () => true,
		getLines: () => lines,
		getTheme: () => theme,
		getActiveTui: () => undefined,
	});

	afterAll(() => cleanup());

	it("keeps pi's blank lines before a thought and between it and the text after it", () => {
		lines = 3;
		const value = message(
			[
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "answer" },
			],
			3_000,
		);
		const component = assistantComponent(value, 1);
		const rendered = component.render(40).map((line) => plain(line).trimEnd());
		expect(rendered).toEqual(["", "  Thought for 3.0s", "", "● answer"]);
		// Both spacers are pi's own and stay in place.
		const children = (component as any).contentContainer.children as unknown[];
		expect(isSpacer(children[0])).toBe(true);
		expect(children.filter(isSpacer)).toHaveLength(2);
	});

	it("leaves a thought in the middle of a message spaced the way pi spaces it", () => {
		lines = 3;
		const value = message(
			[
				{ type: "text", text: "intro" },
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "answer" },
			],
			3_000,
		);
		// pi puts no spacer between text and a following thought, and one after the thought.
		const rendered = assistantComponent(value, 1).render(40).map((line) => plain(line).trimEnd());
		expect(rendered).toEqual(["", "● intro", "  Thought for 3.0s", "", "● answer"]);
	});

	it("keeps the spacers between two thinking runs and before an error note", () => {
		lines = 3;
		const value = {
			...message(
				[
					{ type: "thinking", thinking: "first" },
					{ type: "text", text: "  " },
					{ type: "thinking", thinking: "second" },
				],
				2_000,
			),
			stopReason: "error",
			errorMessage: "boom",
		};
		const rendered = assistantComponent(value, 1).render(40).map((line) => plain(line).trimEnd());
		expect(rendered).toEqual(["", "  Thought for 2.0s", "", "  Thought for 2.0s", "", "  Error: boom"]);
	});

	it("leaves pi's spacing alone when pi draws the thinking block itself", () => {
		lines = 0;
		const value = message(
			[
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "answer" },
			],
			3_000,
		);
		const children = (assistantComponent(value, 1) as any).contentContainer.children as unknown[];
		expect(children.filter(isSpacer)).toHaveLength(2);
		lines = 3;
	});

	it("replaces Pi's native thinking block with a fixed-height view", () => {
		const value = message([{ type: "thinking", thinking: "one\ntwo\nthree\nfour" }]);
		const component = assistantComponent(value);
		component.updateContent(value as any, true);
		const children = (component as any).contentContainer.children as any[];
		const replaced = children.find((child) => child?.child instanceof ThinkingView);
		expect(replaced).toBeTruthy();
		const lines = component.render(80);
		expect(lines.join("\n")).toContain("Thinking");
		expect(lines.filter((line) => line.includes("four")).length).toBeGreaterThan(0);
	});

	it("collapses when an answer has started", () => {
		const value = message(
			[
				{ type: "thinking", thinking: "one\ntwo" },
				{ type: "text", text: "answer" },
			],
			5_000,
		);
		const component = assistantComponent(value);
		const lines = component.render(80).join("\n");
		expect(lines).toContain("Thought for 5.0s");
	});

	it("uses Pi's toggle to expand and collapse the whole thought", () => {
		const value = message(
			[
				{ type: "thinking", thinking: "one\ntwo" },
				{ type: "text", text: "answer" },
			],
			1_000,
		);
		const component = assistantComponent(value);
		expect(component.render(80).join("\n")).toContain("Thought");
		component.setHideThinkingBlock(true);
		expect(component.render(80).join("\n")).toContain("one");
		component.setHideThinkingBlock(false);
		expect(component.render(80).join("\n")).toContain("Thought");
	});
});

describe("thinking patch across reloads", () => {
	it("replaces a patch left on the prototype by an earlier load instead of keeping its code", () => {
		const calls: string[] = [];
		class Fake {
			contentContainer = { children: [] as unknown[] };
			lastMessage = { role: "assistant", content: [] };
			isStreaming = false;
			updateContent(): void {
				calls.push("pi");
			}
			setHideThinkingBlock(): void {}
		}
		const proto = Fake.prototype as any;
		const original = proto.updateContent;
		const stale = function (this: unknown) {
			calls.push("stale");
			return original.call(this);
		};
		// What an earlier build left behind: no owner, its own wrapper installed.
		proto[Symbol.for("pi-bettertui.thinking")] = {
			hooks: {},
			originalUpdateContent: original,
			originalSetHideThinkingBlock: proto.setHideThinkingBlock,
			patchedUpdateContent: stale,
			patchedSetHideThinkingBlock: proto.setHideThinkingBlock,
		};
		proto.updateContent = stale;

		const component = new Fake();
		const hooks = { isEnabled: () => true, getLines: () => 3, getTheme: () => theme, getActiveTui: () => undefined };
		expect(installLiveThinkingPatch({ children: [component] }, hooks)).toBe(true);
		calls.length = 0;
		component.updateContent();
		expect(calls).toEqual(["pi"]);

		uninstallThinkingPatches();
		expect(proto.updateContent).toBe(original);
	});
});
