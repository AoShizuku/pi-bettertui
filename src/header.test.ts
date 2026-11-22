import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG } from "./config.js";
import { BetterHeader, locate } from "./header.js";
import { SessionDivider, SessionDividerSlot } from "./session-divider.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const noHints = () => "";

class FakeSpacer {
	lines: number;
	constructor(lines = 1) {
		this.lines = lines;
	}
	setLines(lines: number): void {
		this.lines = lines;
	}
	render(): string[] {
		return Array.from({ length: this.lines }, () => "");
	}
}

class FakeContainer {
	children: unknown[];
	constructor(children: unknown[] = []) {
		this.children = children;
	}
	render(width: number): string[] {
		return this.children.flatMap((child) => (child as { render(w: number): string[] }).render(width));
	}
}

/** Stand-in for pi's ExpandableText: `build` plus an expand state. */
function section(label: string, items: string[], expanded = false) {
	return {
		state: { expanded },
		build: () => (expanded ? `[${label}]\n  full/path/one\n  full/path/two` : `[${label}]\n  ${items.join(", ")}`),
		render: () => [`[${label}]`, `  ${items.join(", ")}`],
	};
}

function mount(header: BetterHeader, resources: unknown[]) {
	const spacers = [new FakeSpacer(), new FakeSpacer()];
	const headerContainer = new FakeContainer([spacers[0], header, spacers[1]]);
	const resourcesContainer = new FakeContainer(resources);
	const chat = new FakeContainer();
	const document = new FakeContainer([headerContainer, resourcesContainer, chat]);
	const tui = { children: [document], requestRender: vi.fn() } as unknown as TUI;
	return { spacers, resourcesContainer, chat, tui };
}

describe("header line", () => {
	it("renders nothing when the header is off", () => {
		const header = new BetterHeader({ ...DEFAULT_CONFIG, header: "off" }, () => theme, undefined, noHints);
		expect(header.render(80)).toEqual([]);
	});

	it("renders one line with the pi version when compact", () => {
		const header = new BetterHeader({ ...DEFAULT_CONFIG, header: "compact" }, () => theme, undefined, () => "esc interrupt");
		const lines = header.render(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^pi v\d+\.\d+\.\d+ {3}esc interrupt$/);
	});
});

describe("attaching to pi's layout", () => {
	it("finds the header container and the listing right after it", () => {
		const header = new BetterHeader(DEFAULT_CONFIG, () => theme, undefined, noHints);
		const { resourcesContainer, tui } = mount(header, []);
		expect(locate(tui, header)?.resources).toBe(resourcesContainer);
	});

	it("drops the blank lines around the header and restores them on dispose", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		const header = new BetterHeader(config, () => theme, undefined, noHints);
		const { spacers, resourcesContainer, tui } = mount(header, []);
		const attached = new BetterHeader(config, () => theme, tui, noHints);
		(locate(tui, header)!.header.children as unknown[])[1] = attached;
		attached.render(80);
		expect(spacers.map((spacer) => spacer.lines)).toEqual([0, 0]);
		expect(Object.hasOwn(resourcesContainer, "render")).toBe(true);
		attached.dispose();
		expect(spacers.map((spacer) => spacer.lines)).toEqual([1, 1]);
		expect(Object.hasOwn(resourcesContainer, "render")).toBe(false);
	});

	it("drops a new-session confirmation in the very frame that would show it", () => {
		const header = new BetterHeader(DEFAULT_CONFIG, () => theme, undefined, noHints);
		const { chat, tui } = mount(header, []);
		const slot = new SessionDividerSlot(new SessionDivider(() => theme, new Date(2026, 10, 15, 9, 5)));
		const attached = new BetterHeader(DEFAULT_CONFIG, () => theme, tui, noHints, slot);
		(locate(tui, header)!.header.children as unknown[])[1] = attached;
		attached.render(40);
		expect(chat.render(40)[0]).toMatch(/^─ New session · 09:05 ─+$/);

		// pi writes its line after session_start and asks for a frame; that frame already lacks it.
		chat.children.push(new FakeSpacer(), new Text("✓ New session started", 1, 1));
		expect(chat.render(40)).toHaveLength(1);
		expect(chat.children).toEqual([slot.divider]);

		attached.dispose();
		expect(Object.hasOwn(chat, "render")).toBe(false);
	});
});

describe("resource listing", () => {
	const header = new BetterHeader(DEFAULT_CONFIG, () => theme, undefined, noHints);

	it("draws sections as an aligned table without blank lines between them", () => {
		const container = new FakeContainer([
			new FakeSpacer(),
			section("Context", ["AGENTS.md"]),
			new FakeSpacer(),
			section("Skills", ["feishu-doc", "gitee-cli"]),
			new FakeSpacer(),
			section("Extensions", ["pi-hud/src", "pi-subagents:src/extension"]),
			new FakeSpacer(),
		]);
		expect(header.renderResources(container, 80)).toEqual([
			"",
			"[Context]     AGENTS.md",
			"[Skills]      feishu-doc, gitee-cli",
			"[Extensions]  pi-hud, pi-subagents:src/extension",
			"",
		]);
	});

	it("wraps long lists under the item column", () => {
		const container = new FakeContainer([section("Skills", ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"])]);
		expect(header.renderResources(container, 40)).toEqual([
			"",
			"[Skills]  aaaaaaaaaa, bbbbbbbbbb,",
			"          cccccccccc, dddddddddd",
			"",
		]);
	});

	it("puts labels on their own line when the terminal is narrow", () => {
		const container = new FakeContainer([section("Skills", ["aaaa", "bbbb"])]);
		expect(header.renderResources(container, 30)).toEqual(["", "[Skills]", "  aaaa, bbbb", ""]);
	});

	it("leaves pi's expanded listing alone", () => {
		const container = new FakeContainer([new FakeSpacer(), section("Skills", ["a"], true), new FakeSpacer()]);
		expect(header.renderResources(container, 80)).toEqual(["", "[Skills]", "  a", ""]);
	});

	it("keeps warnings below the table", () => {
		const warning = { render: () => ["[Skill warnings]", "  bad skill"] };
		const container = new FakeContainer([section("Skills", ["a"]), new FakeSpacer(), warning, new FakeSpacer()]);
		expect(header.renderResources(container, 80)).toEqual([
			"",
			"[Skills]  a",
			"",
			"[Skill warnings]",
			"  bad skill",
			"",
		]);
	});

	it("starts right at the table when the version line is off", () => {
		const off = new BetterHeader({ ...DEFAULT_CONFIG, header: "off" }, () => theme, undefined, noHints);
		expect(off.renderResources(new FakeContainer([section("Skills", ["a"])]), 80)).toEqual(["[Skills]  a", ""]);
	});

	it("adds no blank line when there is neither a header nor a listing", () => {
		const off = new BetterHeader({ ...DEFAULT_CONFIG, header: "off" }, () => theme, undefined, noHints);
		expect(off.renderResources(new FakeContainer([new FakeSpacer()]), 80)).toEqual([]);
	});
});
