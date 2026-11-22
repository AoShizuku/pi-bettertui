import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { applySetting, settingsItems } from "./settings.js";
import { SETTINGS_CHANNEL, SETTINGS_PROTOCOL, exposeSettings, type SettingsProvider } from "./shizuku-settings.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "bettertui-settings-"));
	dirs.push(dir);
	return join(dir, "better-tui.json");
}

describe("settings items", () => {
	it("reflect the current config and the defaults", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.thinking.lines = 0;
		const items = settingsItems(config);
		const thinking = items.find((item) => item.id === "thinking.lines");
		expect(thinking).toMatchObject({ kind: "int", value: 0, default: 3, min: 0, max: 5, applies: "live" });
		expect(items.find((item) => item.id === "tools.shellDescription")).toMatchObject({ kind: "bool", applies: "reload" });
		expect(items.find((item) => item.id === "header")).toMatchObject({ kind: "enum", value: "compact", values: ["compact", "off"] });
	});
});

describe("applySetting", () => {
	it("changes one field on a copy and the change survives a save", () => {
		const path = tempFile();
		const config = structuredClone(DEFAULT_CONFIG);
		const result = applySetting(config, "fold.minItems", 5);
		if ("error" in result) throw new Error(result.error);
		expect(config.fold.minItems).toBe(2);
		saveConfig(result.config, path);
		expect(loadConfig(path).fold.minItems).toBe(5);
	});

	it("rejects values of the wrong type or out of range, and unknown ids", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		expect(applySetting(config, "thinking.lines", 6)).toHaveProperty("error");
		expect(applySetting(config, "thinking.lines", 1.5)).toHaveProperty("error");
		expect(applySetting(config, "enabled", "yes")).toHaveProperty("error");
		expect(applySetting(config, "header", "full")).toHaveProperty("error");
		expect(applySetting(config, "nope", true)).toHaveProperty("error");
	});

	it("resets a field when given the default", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.turnSummary = false;
		const item = settingsItems(config).find((entry) => entry.id === "turnSummary");
		if (!item || item.kind !== "bool") throw new Error("missing item");
		const result = applySetting(config, "turnSummary", item.default);
		if ("error" in result) throw new Error(result.error);
		expect(result.config.turnSummary).toBe(true);
	});
});

describe("exposeSettings", () => {
	it("hands the provider to a collect request until session_shutdown", () => {
		const listeners = new Map<string, (data: unknown) => void>();
		let shutdown: (() => void) | undefined;
		const pi = {
			events: {
				on: (channel: string, handler: (data: unknown) => void) => {
					listeners.set(channel, handler);
					return () => listeners.delete(channel);
				},
			},
			on: (_event: "session_shutdown", handler: () => void) => {
				shutdown = handler;
			},
		};
		const provider: SettingsProvider = { id: "pi-bettertui", title: "pi-bettertui", items: () => [], set: () => ({ ok: true }) };
		exposeSettings(pi, provider);
		const got: SettingsProvider[] = [];
		listeners.get(SETTINGS_CHANNEL)?.({ protocol: SETTINGS_PROTOCOL, register: (p: SettingsProvider) => got.push(p) });
		expect(got).toEqual([provider]);
		shutdown?.();
		expect(listeners.has(SETTINGS_CHANNEL)).toBe(false);
	});
});
