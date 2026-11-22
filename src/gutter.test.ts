import { afterAll, describe, expect, it } from "vitest";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

import { installUserMessagePatch, placeMarker, refreshLiveUserMessages, uninstallUserMessagePatches } from "./gutter.js";
import { installThinkingPatch } from "./thinking.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

// eslint-disable-next-line no-control-regex
const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\]133;[A-C]\x07/g, "");

function assistant(content: unknown[], outputPad = 1) {
	const message = {
		role: "assistant",
		content,
		api: "openai",
		provider: "openai",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return new AssistantMessageComponent(message as any, false, getMarkdownTheme(), "Thinking...", outputPad);
}

describe("placeMarker", () => {
	it("replaces the first padding column", () => {
		expect(placeMarker("  text", "●")).toBe("● text");
	});

	it("keeps a background opened before the padding in front of the marker", () => {
		expect(placeMarker("\x1b[48;5;236m  text\x1b[49m", "❯")).toBe("\x1b[48;5;236m❯ text\x1b[49m");
	});

	it("leaves lines without leading padding alone", () => {
		expect(placeMarker("text", "●")).toBe("text");
	});
});

describe("assistant text in the gutter", () => {
	initTheme("dark");
	let enabled = true;
	let activeTheme = theme;
	const cleanup = installThinkingPatch({
		isEnabled: () => enabled,
		getLines: () => 0,
		getTheme: () => activeTheme,
		getActiveTui: () => undefined,
	});
	afterAll(() => cleanup());

	it("puts a muted ● in column 0 and the text in column 2, even with native thinking", () => {
		enabled = true;
		const tokens: string[] = [];
		activeTheme = { ...theme, fg: (token: string, text: string) => (tokens.push(token), text) } as unknown as Theme;
		const lines = assistant([{ type: "text", text: "first line\n\nsecond paragraph" }]).render(40).map(plain);
		activeTheme = theme;
		const text = lines.filter((line) => line.trim() !== "");
		expect(text[0]!.startsWith("● first line")).toBe(true);
		expect(tokens).toContain("muted");
		expect(text[1]!.startsWith("  second paragraph")).toBe(true);
	});

	it("goes back to pi's outputPad when disabled", () => {
		enabled = true;
		const component = assistant([{ type: "text", text: "answer" }]);
		component.render(40);
		enabled = false;
		component.invalidate();
		const text = component.render(40).map(plain).filter((line) => line.trim() !== "");
		expect(text[0]!.startsWith(" answer")).toBe(true);
		enabled = true;
	});
});

describe("user message in the gutter", () => {
	initTheme("dark");
	let enabled = true;
	const hooks = { isEnabled: () => enabled, getTheme: () => theme };
	installUserMessagePatch(hooks);
	afterAll(() => uninstallUserMessagePatches());

	it("puts ❯ on the first line of a band with no blank rows", () => {
		enabled = true;
		const lines = new UserMessageComponent("hello", getMarkdownTheme(), 1).render(30);
		expect(lines).toHaveLength(1);
		expect(plain(lines[0]!).startsWith("❯ hello")).toBe(true);
		// The background starts before the marker, so the band stays unbroken.
		expect(lines[0]!.indexOf("\x1b[48")).toBeLessThan(lines[0]!.indexOf("❯"));
	});

	it("keeps image references out of the band and hangs one rail line per image under it", () => {
		enabled = true;
		const text =
			"look [Image #1]\n\n[Image #1: /tmp/pi-clipboard-1.png · 2328×1692]\n\n" +
			"[Image: original 2328x1692, displayed at 2000x1454. Multiply coordinates by 1.16 to map to original image.]";
		const lines = new UserMessageComponent(text, getMarkdownTheme(), 1).render(60);
		// eslint-disable-next-line no-control-regex
		const visible = lines.map((line) => plain(line).replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").trimEnd());
		expect(visible).toEqual(["❯ look [Image #1]", "  └ Image #1 · 2328×1692 → 2000×1454 · file removed"]);
		// The rail line sits outside the band.
		expect(lines[1]!).not.toContain("\x1b[48");
	});

	it("rebuilds messages already on screen when toggled", () => {
		enabled = true;
		const value = new UserMessageComponent("hello", getMarkdownTheme(), 1);
		enabled = false;
		expect(refreshLiveUserMessages({ children: [value] }, hooks)).toBe(1);
		// Disabled: pi's own layout, blank rows included.
		expect(value.render(30)).toHaveLength(3);
		expect(plain(value.render(30)[1]!).startsWith(" hello")).toBe(true);
		enabled = true;
		refreshLiveUserMessages({ children: [value] }, hooks);
		expect(value.render(30)).toHaveLength(1);
		expect(plain(value.render(30)[0]!).startsWith("❯ hello")).toBe(true);
	});
});
