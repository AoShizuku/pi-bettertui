import { describe, expect, it } from "vitest";

import { createDescribedShellTool, SHELL_DESCRIPTION_HINT, withDescriptionParameter } from "./shell-description.js";

type ObjectSchema = {
	properties: Record<string, { description?: string }>;
	required?: string[];
};

describe("shell description override", () => {
	it("adds an optional description right after command", () => {
		const tool = createDescribedShellTool("bash", () => ({}));
		const schema = tool.parameters as ObjectSchema;
		expect(Object.keys(schema.properties)).toEqual(["command", "description", "timeout"]);
		expect(schema.required).toEqual(["command"]);
		expect(schema.properties.description?.description).toBe(SHELL_DESCRIPTION_HINT);
	});

	it("keeps the built-in metadata and leaves activation to Pi", () => {
		for (const name of ["bash", "powershell"] as const) {
			const tool = createDescribedShellTool(name, () => ({}));
			expect(tool.name).toBe(name);
			expect(tool.description).toBeTruthy();
			expect(tool.defaultActive).toBe(false);
			expect(Object.keys((tool.parameters as ObjectSchema).properties)).toContain("description");
		}
	});

	it("does not duplicate an existing description parameter", () => {
		const once = withDescriptionParameter(createDescribedShellTool("bash", () => ({})).parameters);
		expect(Object.keys((once as ObjectSchema).properties)).toEqual(["command", "description", "timeout"]);
	});

	it("runs the command through Pi's implementation", async () => {
		const tool = createDescribedShellTool("bash", () => ({}));
		const result = await tool.execute(
			"call-1",
			{ command: "echo described", description: "打印一行" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = result.content.map((part: { type: string; text?: string }) => part.text ?? "").join("");
		expect(text).toContain("described");
	});
});
