import { describe, expect, it } from "vitest";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import { installLiveThinkingPatch, ThinkingView } from "./thinking.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

describe("live thinking patch", () => {
	initTheme("dark");

	it("finds a live assistant component and replaces its thinking block", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "one\ntwo" },
				{ type: "text", text: "answer" },
			],
			api: "openai",
			provider: "openai",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
			durationMs: 3_000,
		};
		const component = new AssistantMessageComponent(
			message as any,
			false,
			getMarkdownTheme(),
			"Thinking...",
			0,
		);
		const root = { children: [component] };
		const patched = installLiveThinkingPatch(root, {
			isEnabled: () => true,
			getLines: () => 3,
			getTheme: () => theme,
			getActiveTui: () => undefined,
		});
		expect(patched).toBe(true);
		const children = (component as any).contentContainer.children as any[];
		expect(children.some((child) => child?.child instanceof ThinkingView)).toBe(true);
		expect(component.render(80).join("\n")).toContain("Thought for 3.0s");
	});
});
