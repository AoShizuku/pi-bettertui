import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type HeaderMode = "off" | "compact";

export interface BetterTuiConfig {
	enabled: boolean;
	header: HeaderMode;
	thinking: {
		/** 0 disables the replacement and leaves Pi's native thinking block. */
		lines: number;
	};
	tools: {
		compact: boolean;
		groupReadOnly: boolean;
		/** Live output lines shown for a running shell command. */
		shellPreviewLines: number;
		/**
		 * Give bash/powershell an optional `description` parameter and show it in
		 * place of the command. Changes the tool schema, so it applies after /reload.
		 */
		shellDescription: boolean;
	};
	/** `!` / `!!` blocks typed by the user (DESIGN.md §7). */
	userShell: {
		/** Fold a finished block to three rows once a user message sits below it. */
		foldAnswered: boolean;
	};
	turnSummary: boolean;
	/** Fold runs of thinking and read-only tools into one summary line (fold-more.md). */
	fold: {
		enabled: boolean;
		/** Fewest items a segment needs before it folds. */
		minItems: number;
	};
}

export const DEFAULT_CONFIG: BetterTuiConfig = {
	enabled: true,
	header: "compact",
	thinking: {
		lines: 3,
	},
	tools: {
		compact: true,
		groupReadOnly: true,
		shellPreviewLines: 3,
		shellDescription: true,
	},
	userShell: {
		foldAnswered: true,
	},
	turnSummary: true,
	fold: {
		enabled: true,
		minItems: 2,
	},
};

export function getConfigPath(): string {
	return join(getAgentDir(), "better-tui.json");
}

export function loadConfig(path = getConfigPath()): BetterTuiConfig {
	try {
		if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
		return normalize(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: BetterTuiConfig, path = getConfigPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function normalize(value: unknown): BetterTuiConfig {
	const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const thinking = typeof source.thinking === "object" && source.thinking !== null
		? (source.thinking as Record<string, unknown>)
		: {};
	const tools = typeof source.tools === "object" && source.tools !== null
		? (source.tools as Record<string, unknown>)
		: {};
	const fold = typeof source.fold === "object" && source.fold !== null
		? (source.fold as Record<string, unknown>)
		: {};
	const userShell = typeof source.userShell === "object" && source.userShell !== null
		? (source.userShell as Record<string, unknown>)
		: {};
	return {
		enabled: source.enabled !== false,
		header: source.header === "off" ? "off" : "compact",
		thinking: {
			lines: normalizeLines(thinking.lines),
		},
		tools: {
			compact: tools.compact !== false,
			groupReadOnly: tools.groupReadOnly !== false,
			shellPreviewLines: normalizePreview(tools.shellPreviewLines),
			shellDescription: tools.shellDescription !== false,
		},
		userShell: {
			foldAnswered: userShell.foldAnswered !== false,
		},
		turnSummary: source.turnSummary !== false,
		fold: {
			enabled: fold.enabled !== false,
			minItems: normalizeMinItems(fold.minItems),
		},
	};
}

function normalizeMinItems(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.fold.minItems;
	return Math.max(1, Math.min(99, Math.floor(value)));
}

function normalizeLines(value: unknown): number {
	if (value === 0) return 0;
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.thinking.lines;
	return Math.max(1, Math.min(5, Math.floor(value)));
}

function normalizePreview(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.tools.shellPreviewLines;
	return Math.max(0, Math.min(4, Math.floor(value)));
}
