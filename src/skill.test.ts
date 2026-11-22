import { afterAll, describe, expect, it } from "vitest";
import { getMarkdownTheme, initTheme, SkillInvocationMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";

import { installSkillPatch, refreshLiveSkills, uninstallSkillPatches } from "./skill.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

const block = { name: "code-review", location: "/skills/code-review/SKILL.md", content: "# Loop\n\nStep one.", userMessage: undefined };

function component(outputPad = 1) {
	return new SkillInvocationMessageComponent(block, getMarkdownTheme(), outputPad);
}

function render(value: SkillInvocationMessageComponent, width = 80): string[] {
	return value.render(width).map((line) => line.trimEnd());
}

describe("skill invocation patch", () => {
	initTheme("dark");
	let enabled = true;
	const hooks = { isEnabled: () => enabled, getTheme: () => theme };
	installSkillPatch(hooks);
	afterAll(() => uninstallSkillPatches());

	it("draws one bash-style row in the gutter, whatever the outputPad", () => {
		enabled = true;
		expect(render(component())).toEqual(["● [Skill] (code-review) ▸"]);
		expect(render(component(2))).toEqual(["● [Skill] (code-review) ▸"]);
	});

	it("drops the background", () => {
		enabled = true;
		const raw = component().render(80);
		expect(raw).toHaveLength(1);
		expect(raw[0]).not.toContain("\x1b[48");
	});

	it("expands to the skill content under the row", () => {
		enabled = true;
		const value = component();
		value.setExpanded(true);
		const lines = render(value);
		expect(lines[0]).toBe("● [Skill] (code-review) ▾");
		expect(lines.some((line) => line.includes("Step one."))).toBe(true);
		value.setExpanded(false);
		expect(render(value)).toEqual(["● [Skill] (code-review) ▸"]);
	});

	it("restores pi's own box when disabled", () => {
		const value = component();
		enabled = false;
		value.invalidate();
		const lines = render(value);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join("\n")).toContain("[skill]");
		enabled = true;
		value.invalidate();
		expect(render(value)).toEqual(["● [Skill] (code-review) ▸"]);
	});

	it("finds and rebuilds skill messages already on screen", () => {
		enabled = false;
		const value = component();
		enabled = true;
		const tree = { children: [{ children: [value] }, { child: { children: [] } }] };
		expect(refreshLiveSkills(tree, hooks)).toBe(1);
		expect(render(value)).toEqual(["● [Skill] (code-review) ▸"]);
	});
});
