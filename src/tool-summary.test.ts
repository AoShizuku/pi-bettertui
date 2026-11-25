import { describe, expect, it } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

import { callDetail, isFailed, isInterrupted, resultLines, SHELL_COMMAND_MAX_WIDTH, summarizeResult } from "./tool-summary.js";
import type { ToolResultSnapshot } from "./types.js";

const result = (text: string, details?: unknown, isError = false): ToolResultSnapshot => ({
	content: [{ type: "text", text }],
	details,
	isError,
});

describe("tool summaries", () => {
	it("summarizes reads by line count", () => {
		expect(summarizeResult("read", result("one\ntwo\nthree"), { file_path: "a.ts" })).toBe("3 lines");
	});

	it("says when the model could not see an image it read", () => {
		const image = (details?: unknown): ToolResultSnapshot => ({
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
			details,
			isError: false,
		});
		expect(summarizeResult("read", image(), { path: "a.png" })).toBe("image");
		expect(summarizeResult("read", image({ imageUnsupportedByModel: "text-only-1" }), { path: "a.png" })).toBe(
			"image · model has no image input",
		);
	});

	it("summarizes grep matches and files", () => {
		const output = "src/a.ts:1: foo\nsrc/a.ts:2: foo\nsrc/b.ts:4: foo";
		expect(summarizeResult("grep", result(output), { pattern: "foo" })).toBe("3 matches in 2 files");
	});

	it("summarizes edits from the diff details", () => {
		const details = { diff: "--- a\n+++ b\n+one\n+two\n-old" };
		expect(summarizeResult("edit", result("", details), { file_path: "a.ts" })).toBe("+2 −1");
	});

	it("marks shell failures without inventing an exit code", () => {
		expect(summarizeResult("bash", result("Command exited with code 2", undefined, true), { command: "false" })).toBe(
			"Failed (exit 2) · 1 line",
		);
	});

	it("builds compact call details", () => {
		expect(callDetail("read", { file_path: "/repo/src/a.ts", offset: 10, limit: 20 }, "/repo")).toBe(
			"src/a.ts:10-29",
		);
		expect(callDetail("bash", { command: "npm test\nsecond" }, "/repo")).toBe("npm test … (+1 lines)");
	});

	it("prefers the shell description over the command", () => {
		const args = { command: "npm run build && npm test -- --coverage", description: "构建并运行\n测试" };
		expect(callDetail("bash", args, "/repo")).toBe("构建并运行 测试");
		expect(callDetail("powershell", { ...args, description: "  " }, "/repo")).toBe(args.command);
	});

	it("caps a long command from the middle", () => {
		const command = `git log --oneline ${"--author=someone ".repeat(10)}| head -20`;
		const detail = callDetail("bash", { command: `${command}\nsecond` }, "/repo");
		const head = detail.replace(/ … \(\+1 lines\)$/, "");
		expect(visibleWidth(head)).toBeLessThanOrEqual(SHELL_COMMAND_MAX_WIDTH);
		expect(head.startsWith("git log --oneline")).toBe(true);
		expect(head.endsWith("| head -20")).toBe(true);
		expect(detail.endsWith(" … (+1 lines)")).toBe(true);
	});

	it("keeps the tail for shell output", () => {
		expect(resultLines(result("one\ntwo\nthree"), 2, "tail")).toEqual(["two", "three"]);
	});
});

describe("interrupted calls", () => {
	it("recognises pi's abort texts on the last line of an error result", () => {
		for (const text of ["Operation aborted", "aborted", "Command aborted", "Request was aborted", "Aborted after 2 retry attempts"]) {
			expect(isInterrupted(result(text, undefined, true))).toBe(true);
		}
		// A command's own output above pi's status line does not matter.
		expect(isInterrupted(result("PASS a.test.ts\n\nCommand aborted", undefined, true))).toBe(true);
	});

	it("leaves real failures and successful results alone", () => {
		expect(isInterrupted(result("Operation aborted"))).toBe(false);
		expect(isInterrupted(result("Aborted (core dumped)\nCommand exited with code 134", undefined, true))).toBe(false);
		expect(isInterrupted(result("ENOENT: no such file", undefined, true))).toBe(false);
		expect(isFailed(result("ENOENT: no such file", undefined, true))).toBe(true);
		expect(isFailed(result("Operation aborted", undefined, true))).toBe(false);
	});
});
