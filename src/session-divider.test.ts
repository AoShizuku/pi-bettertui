import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";

import { SessionDivider, SessionDividerSlot } from "./session-divider.js";

const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;

/** pi's ThemedText: a Text whose words come from `build`, filled in on first render. */
function themed(text: string, paddingX = 1, paddingY = 0): Text {
	const value = new Text("", paddingX, paddingY) as Text & { build: () => string };
	value.build = () => `\x1b[36m${text}\x1b[39m`;
	return value;
}

const slot = () => new SessionDividerSlot(new SessionDivider(() => theme, new Date(2026, 10, 15, 9, 5)));

describe("new-session divider", () => {
	it("draws a full-width titled rule with the time", () => {
		const line = slot().divider.render(40)[0]!;
		expect(line.startsWith("─ New session · 09:05 ─")).toBe(true);
		expect(line.endsWith("─")).toBe(true);
		expect(visibleWidth(line)).toBe(40);
	});

	it("goes on top of the cleared transcript once", () => {
		const top = slot();
		const chat = { children: [] as unknown[] };
		expect(top.update(chat)).toBe(true);
		expect(chat.children).toEqual([top.divider]);
		expect(top.update(chat)).toBe(false);
	});

	it("drops pi's `/new` confirmation and pi-clear's notice, each with its blank line", () => {
		const top = slot();
		const chat = { children: [] as unknown[] };
		top.update(chat);
		chat.children.push(new Spacer(1), themed("New session started"), new Spacer(1), themed("✓ New session started", 1, 1));
		expect(top.update(chat)).toBe(true);
		expect(chat.children).toEqual([top.divider]);
	});

	it("keeps notices it does not recognise below the divider", () => {
		const top = slot();
		const warning = themed("Warning: models.json has an unknown field");
		const chat = { children: [new Spacer(1), warning] as unknown[] };
		top.update(chat);
		expect(chat.children[0]).toBe(top.divider);
		expect(chat.children).toContain(warning);
	});

	it("stops at the first message and once pi clears the transcript again", () => {
		const top = slot();
		const chat = { children: [] as unknown[] };
		top.update(chat);
		const message = new Container();
		const later = themed("New session started");
		chat.children.push(message, later);
		expect(top.update(chat)).toBe(false);
		expect(chat.children).toContain(later);

		// `/tree` rebuilt the transcript: the divider is gone and does not come back.
		chat.children = [themed("New session started")];
		expect(top.update(chat)).toBe(false);
		expect(chat.children).not.toContain(top.divider);
	});
});
