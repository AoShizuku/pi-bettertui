import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";

import betterTui, { turnSummaryLine } from "./index.js";

describe("pi-bettertui", () => {
	it("exports an extension factory", () => {
		expect(typeof betterTui).toBe("function");
	});
});

describe("turn summary line", () => {
	const theme = { fg: (token: string, text: string) => `<${token}>${text}` } as unknown as Theme;

	it("keeps a finished run dim", () => {
		expect(turnSummaryLine({ durationMs: 125_000, tools: 7 }, theme)).toBe("<dim>✻ Worked for 2m 5s · 7 tools");
	});

	it("says Interrupted in warning and the rest dim", () => {
		expect(turnSummaryLine({ durationMs: 12_000, tools: 1, aborted: true }, theme)).toBe(
			"<dim>✻ <warning>Interrupted<dim> after 12s · 1 tool",
		);
	});
});
