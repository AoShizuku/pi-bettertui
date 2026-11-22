// Settings exposed to the /shizuku panel (pi-shizuku-settings). Each entry maps one field of better-tui.json
// to a panel item; the panel calls applySetting() and index.ts saves the result and applies it like /bettertui does.

import { DEFAULT_CONFIG, type BetterTuiConfig, type HeaderMode } from "./config.js";
import type { SettingApplies, SettingItem, SettingValue } from "./shizuku-settings.js";

type Field =
	| { kind: "bool"; get(config: BetterTuiConfig): boolean; put(config: BetterTuiConfig, value: boolean): void }
	| { kind: "int"; min: number; max: number; get(config: BetterTuiConfig): number; put(config: BetterTuiConfig, value: number): void }
	| {
			kind: "enum";
			values: readonly string[];
			get(config: BetterTuiConfig): string;
			put(config: BetterTuiConfig, value: string): void;
	  };

type Entry = Field & { id: string; label: string; description: string; applies?: SettingApplies };

const HEADER_MODES: readonly HeaderMode[] = ["compact", "off"];

const ENTRIES: readonly Entry[] = [
	{
		id: "enabled",
		kind: "bool",
		label: "Enabled",
		description: "Turn the whole pi-bettertui layout on or off; off leaves pi's native transcript.",
		get: (c) => c.enabled,
		put: (c, v) => (c.enabled = v),
	},
	{
		id: "header",
		kind: "enum",
		values: HEADER_MODES,
		label: "Header",
		description: "compact replaces pi's startup header with a short one; off removes it.",
		get: (c) => c.header,
		put: (c, v) => (c.header = v as HeaderMode),
	},
	{
		id: "thinking.lines",
		kind: "int",
		min: 0,
		max: 5,
		label: "Thinking lines",
		description: "Height of the fixed thinking window; 0 keeps pi's native thinking block.",
		get: (c) => c.thinking.lines,
		put: (c, v) => (c.thinking.lines = v),
	},
	{
		id: "tools.compact",
		kind: "bool",
		label: "Compact tool rows",
		description: "Draw built-in tool calls as one-line rows instead of pi's tool boxes.",
		get: (c) => c.tools.compact,
		put: (c, v) => (c.tools.compact = v),
	},
	{
		id: "tools.groupReadOnly",
		kind: "bool",
		label: "Group read-only tools",
		description: "Collect consecutive read-only tool calls (read, grep, ls…) under one activity row.",
		get: (c) => c.tools.groupReadOnly,
		put: (c, v) => (c.tools.groupReadOnly = v),
	},
	{
		id: "tools.shellPreviewLines",
		kind: "int",
		min: 0,
		max: 4,
		label: "Shell preview lines",
		description: "Live output lines shown under a running shell command.",
		get: (c) => c.tools.shellPreviewLines,
		put: (c, v) => (c.tools.shellPreviewLines = v),
	},
	{
		id: "tools.shellDescription",
		kind: "bool",
		label: "Shell descriptions",
		description: "Give bash/powershell a description parameter and show it in place of the command. Changes the tool schema.",
		applies: "reload",
		get: (c) => c.tools.shellDescription,
		put: (c, v) => (c.tools.shellDescription = v),
	},
	{
		id: "userShell.foldAnswered",
		kind: "bool",
		label: "Fold answered ! blocks",
		description: "Fold a finished ! / !! block to three rows once a user message sits below it.",
		get: (c) => c.userShell.foldAnswered,
		put: (c, v) => (c.userShell.foldAnswered = v),
	},
	{
		id: "turnSummary",
		kind: "bool",
		label: "Turn summary",
		description: "Add a ✻ Worked for … line after each run.",
		get: (c) => c.turnSummary,
		put: (c, v) => (c.turnSummary = v),
	},
	{
		id: "fold.enabled",
		kind: "bool",
		label: "Fold activity",
		description: "Fold runs of thinking and read-only tools into one summary line.",
		get: (c) => c.fold.enabled,
		put: (c, v) => (c.fold.enabled = v),
	},
	{
		id: "fold.minItems",
		kind: "int",
		min: 1,
		max: 99,
		label: "Fold min items",
		description: "Fewest items a run needs before it folds.",
		get: (c) => c.fold.minItems,
		put: (c, v) => (c.fold.minItems = v),
	},
];

export function settingsItems(config: BetterTuiConfig): SettingItem[] {
	return ENTRIES.map((entry): SettingItem => {
		const base = { id: entry.id, label: entry.label, description: entry.description, applies: entry.applies ?? "live" };
		switch (entry.kind) {
			case "bool":
				return { ...base, kind: "bool", value: entry.get(config), default: entry.get(DEFAULT_CONFIG) };
			case "int":
				return { ...base, kind: "int", value: entry.get(config), default: entry.get(DEFAULT_CONFIG), min: entry.min, max: entry.max };
			case "enum":
				return { ...base, kind: "enum", value: entry.get(config), default: entry.get(DEFAULT_CONFIG), values: entry.values };
		}
	});
}

/** A copy of `config` with one field changed, or an error for an unknown id or a value out of range. */
export function applySetting(
	config: BetterTuiConfig,
	id: string,
	value: SettingValue,
): { config: BetterTuiConfig } | { error: string } {
	const entry = ENTRIES.find((candidate) => candidate.id === id);
	if (!entry) return { error: `unknown setting ${id}` };
	const next = structuredClone(config);
	switch (entry.kind) {
		case "bool":
			if (typeof value !== "boolean") return { error: `${entry.label} must be on or off` };
			entry.put(next, value);
			break;
		case "int":
			if (typeof value !== "number" || !Number.isInteger(value) || value < entry.min || value > entry.max) {
				return { error: `${entry.label} must be an integer from ${entry.min} to ${entry.max}` };
			}
			entry.put(next, value);
			break;
		case "enum":
			if (typeof value !== "string" || !entry.values.includes(value)) {
				return { error: `${entry.label} must be one of ${entry.values.join(", ")}` };
			}
			entry.put(next, value);
			break;
	}
	return { config: next };
}
