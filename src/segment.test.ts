import { describe, expect, it } from "vitest";

import {
	classifyBlock,
	type FoldPolicy,
	type FoldStats,
	isMutatingShell,
	summaryMarker,
	summaryText,
	thinkingRuns,
} from "./segment.js";
import { isManagedTool } from "./tool-summary.js";

const policy: FoldPolicy = { enabled: true, minItems: 2, thinking: true, manage: isManagedTool };
const call = (name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id: "x", name, arguments: args });

describe("classifyBlock", () => {
	it("folds thinking and read-only tools, and ends a segment at text, changes and other tools", () => {
		expect(classifyBlock({ type: "thinking", thinking: "hmm" }, policy)).toBe("fold");
		expect(classifyBlock({ type: "thinking", thinking: "  " }, policy)).toBe("skip");
		expect(classifyBlock({ type: "text", text: "answer" }, policy)).toBe("text");
		expect(classifyBlock({ type: "text", text: "\n" }, policy)).toBe("skip");
		for (const name of ["read", "grep", "find", "ls"]) expect(classifyBlock(call(name, { path: "src" }), policy)).toBe("fold");
		expect(classifyBlock(call("bash", { command: "npm test" }), policy)).toBe("fold");
		expect(classifyBlock(call("edit", { path: "a.ts" }), policy)).toBe("mutation");
		expect(classifyBlock(call("write", { path: "a.ts" }), policy)).toBe("mutation");
		expect(classifyBlock(call("bash", { command: "rm -rf dist" }), policy)).toBe("mutation");
		expect(classifyBlock(call("mcp_search"), policy)).toBe("opaque");
		expect(classifyBlock(call("read", { file_path: "/s/demo/SKILL.md" }), policy)).toBe("opaque");
	});

	it("makes thinking a text boundary when thinking does not fold (thinking 0)", () => {
		expect(classifyBlock({ type: "thinking", thinking: "hmm" }, { ...policy, thinking: false })).toBe("text");
	});

	it("lets a command or read join while its arguments are still streaming", () => {
		expect(classifyBlock(call("bash", { command: "rm -rf dist" }), policy, false)).toBe("fold");
		expect(classifyBlock(call("read", { file_path: "/s/demo/SKILL.md" }), policy, false)).toBe("fold");
		expect(classifyBlock(call("edit", { path: "a.ts" }), policy, false)).toBe("mutation");
	});
});

describe("isMutatingShell", () => {
	it.each([
		"git commit -m 'x'",
		"git -C repo push origin main",
		"cd pkg && git stash",
		"rm -rf dist",
		"mkdir -p out && touch out/a",
		"sudo chmod +x run.sh",
		"FOO=1 mv a b",
		"sed -i 's/a/b/' file.txt",
		"perl -pi -e 's/a/b/' x",
		"echo hi > out.txt",
		"cat a >> log.txt",
		"npm test 2>&1 | tee build.log",
		"npm install",
		"pnpm add -D vitest",
		"yarn",
		"pip install requests",
		"cargo add serde",
		"ls | xargs rm",
		"find . -name '*.tmp' -delete",
		"bash -c 'rm -rf build'",
		"cat <<EOF > notes.md\nhello\nEOF",
		"Remove-Item -Recurse dist",
		"Get-Content a | Set-Content b",
	])("treats %j as a change", (command) => {
		expect(isMutatingShell(command)).toBe(true);
	});

	it.each([
		"npm test",
		"npm run build --if-present",
		"git status --short",
		"git -C repo log --oneline -5",
		"git log --grep='commit'",
		"ls -la src",
		"cat a.txt 2>/dev/null",
		"npm test > /dev/null 2>&1",
		"node -e \"console.log(1 > 0)\"",
		"rg -n 'a > b' src",
		"cat <<EOF\nrm -rf /\nEOF",
		"Get-ChildItem -Recurse | Select-String foo",
		"cargo build",
		"yarn build",
		"echo hi >&2",
		"Get-Content x > $null",
	])("leaves %j folded", (command) => {
		expect(isMutatingShell(command)).toBe(false);
	});
});

describe("thinkingRuns", () => {
	it("numbers runs like pi: consecutive thinking blocks, runs without text get no index", () => {
		const runs = thinkingRuns([
			{ type: "thinking", thinking: "" },
			{ type: "toolCall", id: "a", name: "read", arguments: {} },
			{ type: "thinking", thinking: " one " },
			{ type: "thinking", thinking: "two" },
			{ type: "text", text: " " },
			{ type: "thinking", thinking: "three" },
		]);
		expect(runs).toEqual([
			{ runIndex: 0, text: "one\n\ntwo", firstBlock: 2, lastBlock: 3 },
			{ runIndex: 1, text: "three", firstBlock: 5, lastBlock: 5 },
		]);
	});
});

describe("summary line", () => {
	const base: FoldStats = {
		thinking: { count: 0, active: false },
		commands: { count: 0, active: false },
		reads: 0,
		searches: 0,
		lists: 0,
		exploreActive: false,
		tools: 0,
		failed: 0,
		interrupted: 0,
	};

	it("gives each kind its own tense", () => {
		expect(summaryText({
			...base,
			thinking: { count: 2, ms: 12_400, active: true },
			commands: { count: 2, active: false },
			reads: 5,
			searches: 1,
			tools: 8,
		})).toBe("Thinking 12s · Ran 2 commands · Read 5 files · 1 search");
		expect(summaryText({
			...base,
			thinking: { count: 2, ms: 8_000, active: false },
			commands: { count: 1, active: true },
			reads: 1,
			tools: 2,
		})).toBe("Thought for 8.0s · Running 1 command · Read 1 file");
		expect(summaryText({ ...base, searches: 2, lists: 1, exploreActive: true, tools: 3 })).toBe("Searching 2 patterns · 1 dir");
		expect(summaryText({ ...base, lists: 2, tools: 2 })).toBe("Listed 2 dirs");
	});

	it("leaves the thought duration out when no message recorded one", () => {
		expect(summaryText({ ...base, thinking: { count: 1, active: false }, commands: { count: 1, active: false }, tools: 1 })).toBe("Ran 1 command");
		expect(summaryText({ ...base, thinking: { count: 2, active: false } })).toBe("Thought");
	});

	it("marks partial failure with ! and total failure with ×", () => {
		expect(summaryMarker({ ...base, tools: 3 })).toBe(" ");
		expect(summaryMarker({ ...base, tools: 3, failed: 1 })).toBe("!");
		expect(summaryMarker({ ...base, tools: 3, failed: 3 })).toBe("×");
	});
});
