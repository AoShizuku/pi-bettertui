import { type ExtensionAPI, type ExtensionContext, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG, getConfigPath, loadConfig, saveConfig, type BetterTuiConfig } from "./config.js";
import { formatDuration } from "./format.js";
import { installUserMessagePatch, refreshLiveUserMessages, uninstallUserMessagePatches } from "./gutter.js";
import { installHeader } from "./header.js";
import { summarizedInterrupts } from "./interrupt.js";
import { installLiveThinkingPatch, uninstallThinkingPatches } from "./thinking.js";
import type { FoldPolicy } from "./segment.js";
import { ActivityTimeline } from "./timeline.js";
import { applySetting, settingsItems } from "./settings.js";
import { createDescribedShellTool, SHELL_TOOL_NAMES } from "./shell-description.js";
import { exposeSettings } from "./shizuku-settings.js";
import { installSkillPatch, refreshLiveSkills, uninstallSkillPatches } from "./skill.js";
import { RUNNING_BLOCK_DELAY_MS } from "./tool-lines.js";
import { createToolRenderers } from "./tool-row.js";
import { isManagedTool, isShellTool } from "./tool-summary.js";
import { installUserShellPatch, refreshLiveUserShells, uninstallUserShellPatches } from "./user-shell.js";

const TURN_SUMMARY_ENTRY = "better-tui-turn";

interface TurnSummaryData {
	durationMs: number;
	tools: number;
	aborted?: boolean;
}

/**
 * `✻ Worked for 2m 5s · 7 tools`, or `✻ Interrupted after 12s · 3 tools` with the one word in
 * warning (DESIGN.md §5, §9). ✻ takes the gutter's column 0 like every other transcript marker.
 */
export function turnSummaryLine(data: TurnSummaryData, theme: Theme): string {
	const tools = data.tools > 0 ? ` · ${data.tools} tool${data.tools === 1 ? "" : "s"}` : "";
	const rest = `${formatDuration(data.durationMs)}${tools}`;
	if (data.aborted) return `${theme.fg("dim", "✻ ")}${theme.fg("warning", "Interrupted")}${theme.fg("dim", ` after ${rest}`)}`;
	return theme.fg("dim", `✻ Worked for ${rest}`);
}

export default function betterTui(pi: ExtensionAPI): void {
	let config: BetterTuiConfig = loadConfig();
	let activeCtx: ExtensionContext | undefined;
	let activeTui: TUI | undefined;
	let fallbackTheme: Theme | undefined;
	let headerCleanup: (() => void) | undefined;
	let builtinCache = new Map<string, boolean>();
	let runStartedAt: number | undefined;
	let runTools = 0;
	let liveThinkingPatched = false;
	let liveThinkingTimers: ReturnType<typeof setTimeout>[] = [];
	let seedTimers: ReturnType<typeof setTimeout>[] = [];
	let skillTimers: ReturnType<typeof setTimeout>[] = [];
	let userShellTimers: ReturnType<typeof setTimeout>[] = [];

	const plainTheme = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		dim: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		style: (text: string) => text,
		colors: {},
	} as unknown as Theme;
	const getTheme = (): Theme => {
		try {
			return activeCtx?.ui.theme ?? fallbackTheme ?? plainTheme;
		} catch {
			return fallbackTheme ?? plainTheme;
		}
	};

	// Parameter schemas of the shell overrides registered below. A later extension that
	// overrides bash again brings its own schema, so identity tells the two apart.
	const ownShellSchemas = new WeakSet<object>();
	// The schema change needs a reload, so this reflects the config at load time.
	const shellDescriptionLoaded = config.enabled && config.tools.compact && config.tools.shellDescription;
	if (shellDescriptionLoaded) {
		for (const name of SHELL_TOOL_NAMES) {
			const tool = createDescribedShellTool(name, () => pi.getSettings());
			ownShellSchemas.add(tool.parameters);
			pi.registerTool(tool);
		}
	}

	const refreshBuiltins = (): void => {
		const next = new Map<string, boolean>();
		for (const tool of pi.getAllTools()) {
			const source = (tool as { sourceInfo?: { source?: string } }).sourceInfo?.source;
			const own = typeof tool.parameters === "object" && tool.parameters !== null && ownShellSchemas.has(tool.parameters);
			next.set(tool.name, source === "builtin" || source === undefined || own);
		}
		builtinCache = next;
	};

	const isBuiltin = (name: string): boolean => builtinCache.get(name) ?? true;

	const isManaged = (name: string): boolean =>
		config.enabled && config.tools.compact && isManagedTool(name) && isBuiltin(name);

	const timeline = new ActivityTimeline();

	/** Fold needs the compact rows it hides; `thinking 0` leaves thinking to pi as a text boundary. */
	const foldPolicy = (): FoldPolicy => ({
		enabled: config.enabled && config.tools.compact && config.fold.enabled,
		minItems: config.fold.minItems,
		thinking: config.thinking.lines > 0,
		manage: isManaged,
	});
	// Resume can build tool rows before session_start seeds; they must already see fold's policy,
	// or they would form read-only groups whose hidden members keep an empty component.
	timeline.setFoldPolicy(foldPolicy());
	// A segment hosted by a thinking run has no tool row to invalidate; a frame is enough.
	timeline.onFoldChange = () => requestRender();

	const applyHeader = (ctx: ExtensionContext, newSession = false): void => {
		headerCleanup?.();
		headerCleanup = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") {
			activeTui = undefined;
			return;
		}
		activeCtx = ctx;
		fallbackTheme = ctx.ui.theme;
		if (!config.enabled) {
			ctx.ui.setHeader(undefined);
			activeTui = undefined;
			return;
		}
		// `/new` and `/clear` open with a divider instead of a confirmation line (DESIGN.md §10).
		headerCleanup = installHeader(ctx, config, getTheme, (tui) => {
			activeTui = tui;
		}, newSession);
	};

	/** Aborted assistant messages whose `✻ Interrupted` summary stands in for pi's abort note (DESIGN.md §9). */
	let summarized = new Set<number>();
	/** Aborted assistant messages of the run in progress, until its summary is written. */
	let runAborted: number[] = [];

	/** Whether the run in progress ends with a `✻` summary line. */
	const writesSummary = (): boolean =>
		config.enabled && config.turnSummary && runStartedAt !== undefined && activeCtx?.hasUI === true && activeCtx.mode === "tui";

	const seed = (ctx: ExtensionContext): void => {
		refreshBuiltins();
		timeline.setFoldPolicy(foldPolicy());
		const branch = ctx.sessionManager.getBranch();
		timeline.seed(branch, config.tools.groupReadOnly, isManaged);
		summarized = summarizedInterrupts(branch, TURN_SUMMARY_ENTRY);
	};

	/** A fold-related config change rebuilt the model; set while a run is going on. */
	let reseedPending = false;

	/**
	 * Rebuild rows and segments under the current config and make pi rebuild every tool row's
	 * component: a row that was a hidden group member holds an empty component until pi calls
	 * its renderer again. A run in progress is left alone and rebuilt once it settles.
	 */
	const refreshFold = (ctx: ExtensionContext): void => {
		if (runStartedAt !== undefined) {
			reseedPending = true;
			return;
		}
		reseedPending = false;
		const invalidators = timeline.rowInvalidators();
		seed(ctx);
		for (const invalidate of invalidators) invalidate();
	};

	const cancelSeedTimers = (): void => {
		for (const timer of seedTimers) clearTimeout(timer);
		seedTimers = [];
	};

	/** Resume can build the transcript before session_start; reseed once storage is ready. */
	const scheduleSeed = (ctx: ExtensionContext): void => {
		cancelSeedTimers();
		for (const delay of [0, 50, 200, 500, 1_000]) {
			seedTimers.push(setTimeout(() => {
				if (activeCtx !== ctx || runStartedAt !== undefined) return;
				seed(ctx);
				requestRender();
			}, delay));
		}
	};

	const requestRender = (): void => {
		activeTui?.requestRender();
	};

	const runningBlockTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const cancelRunningBlockTimers = (): void => {
		for (const timer of runningBlockTimers.values()) clearTimeout(timer);
		runningBlockTimers.clear();
	};

	/**
	 * A command's preview block opens once it has run for RUNNING_BLOCK_DELAY_MS. Rows derive that
	 * from the clock on every render, and pi's working indicator usually redraws often enough;
	 * one redraw right after the delay makes sure the block does not wait for the next output.
	 */
	const scheduleRunningBlock = (id: string): void => {
		if (runningBlockTimers.has(id)) return;
		runningBlockTimers.set(id, setTimeout(() => {
			runningBlockTimers.delete(id);
			const row = timeline.row(id);
			if (!row || row.endedAt !== undefined) return;
			timeline.refresh(id);
			requestRender();
		}, RUNNING_BLOCK_DELAY_MS + 16));
	};

	const thinkingHooks = {
		isEnabled: () => config.enabled,
		getLines: () => config.thinking.lines,
		getTheme,
		getActiveTui: () => activeTui,
		fold: {
			timeline,
			getConfig: () => config,
			getCwd: () => activeCtx?.cwd ?? process.cwd(),
		},
		interrupt: {
			// While the run settles its summary is still to come; the note must not flash up first.
			summaryFollows: (timestamp: number) =>
				summarized.has(timestamp) || (runAborted.includes(timestamp) && writesSummary()),
			getTheme,
		},
	};

	const ensureLiveThinking = (): void => {
		// The same patch carries the assistant gutter, so it is needed even with native thinking.
		if (liveThinkingPatched || !config.enabled || !activeTui) return;
		liveThinkingPatched = installLiveThinkingPatch(activeTui, thinkingHooks);
	};

	const scheduleLiveThinking = (): void => {
		for (const timer of liveThinkingTimers) clearTimeout(timer);
		liveThinkingTimers = [];
		liveThinkingPatched = false;
		for (const delay of [0, 50, 200, 500, 1_000]) {
			liveThinkingTimers.push(setTimeout(() => {
				ensureLiveThinking();
			}, delay));
		}
	};

	const skillHooks = {
		isEnabled: () => config.enabled,
		getTheme,
	};
	installSkillPatch(skillHooks);
	// User messages get the ❯ marker in the gutter; same switch and theme as the skill rows.
	installUserMessagePatch(skillHooks);

	// `!` / `!!` blocks drawn as a rounded box (DESIGN.md §7); the box is derived on every render.
	const userShellHooks = {
		isEnabled: () => config.enabled,
		getTheme,
		expandKey: () => keyText("app.tools.expand"),
		// Three rows once a user message sits below (§7.4); the tree finds a block pi moved.
		foldAnswered: () => config.userShell.foldAnswered,
		getRoot: () => activeTui,
	};
	installUserShellPatch(userShellHooks);

	/** Rebuild skill and user messages already on screen; `tui` covers a disable, which drops activeTui. */
	const refreshSkills = (tui: TUI | undefined = activeTui): void => {
		if (!tui) return;
		const rebuilt =
			refreshLiveSkills(tui, skillHooks) +
			refreshLiveUserMessages(tui, skillHooks) +
			refreshLiveUserShells(tui, userShellHooks);
		if (rebuilt > 0) tui.requestRender();
	};

	const cancelUserShellTimers = (): void => {
		for (const timer of userShellTimers) clearTimeout(timer);
		userShellTimers = [];
	};

	/** pi builds the shell block right after `user_bash`; find its prototype once it is on screen. */
	const scheduleUserShellRefresh = (): void => {
		cancelUserShellTimers();
		for (const delay of [0, 50, 200]) {
			userShellTimers.push(setTimeout(() => {
				if (activeTui && refreshLiveUserShells(activeTui, userShellHooks) > 0) activeTui.requestRender();
			}, delay));
		}
	};

	const cancelSkillTimers = (): void => {
		for (const timer of skillTimers) clearTimeout(timer);
		skillTimers = [];
	};

	/** The transcript and a new skill message are built after the events that announce them. */
	const scheduleSkillRefresh = (delays: readonly number[] = [0, 50, 200, 500, 1_000]): void => {
		cancelSkillTimers();
		for (const delay of delays) {
			skillTimers.push(setTimeout(() => refreshSkills(), delay));
		}
	};

	const applyConfigChange = (ctx: ExtensionContext): void => {
		const previousTui = activeTui;
		// Segments depend on these switches; any other change keeps the model (and expanded rows).
		const before = timeline.foldPolicy;
		const after = foldPolicy();
		if (
			(before.enabled || after.enabled) &&
			(before.enabled !== after.enabled || before.minItems !== after.minItems || before.thinking !== after.thinking)
		) {
			refreshFold(ctx);
		}
		applyHeader(ctx);
		refreshSkills(activeTui ?? previousTui);
		// Enabling hands over the TUI only once pi rebuilds the header.
		scheduleSkillRefresh();
		timeline.bumpEpoch();
		if (ctx.hasUI && ctx.mode === "tui") {
			// Rebuild assistant thinking blocks with the new presentation.
			ctx.ui.setHiddenThinkingLabel();
		}
		scheduleLiveThinking();
		requestRender();
	};

	const status = (): string => {
		const thinking = config.thinking.lines === 0 ? "native" : String(config.thinking.lines);
		return [
			`enabled=${config.enabled ? "on" : "off"}`,
			`header=${config.header}`,
			`thinking=${thinking}`,
			`tools=${config.tools.compact ? "compact" : "native"}`,
			`group=${config.tools.groupReadOnly ? "read-only" : "off"}`,
			`describe=${config.tools.shellDescription ? "on" : "off"}${describePending() ? " (after /reload)" : ""}`,
			`shellfold=${config.userShell.foldAnswered ? "on" : "off"}`,
			`summary=${config.turnSummary ? "on" : "off"}`,
			`fold=${config.fold.enabled ? `on (≥${config.fold.minItems})` : "off"}`,
		].join(" · ");
	};

	/** Whether the shell override at load time no longer matches the config. */
	const describePending = (): boolean =>
		shellDescriptionLoaded !== (config.enabled && config.tools.compact && config.tools.shellDescription);

	pi.registerToolRenderer((toolName, next) => {
		const native = next();
		if (!isManaged(toolName)) return native;
		return createToolRenderers(toolName, native, {
			timeline,
			getConfig: () => config,
			getTheme,
		});
	});

	pi.registerEntryRenderer(TURN_SUMMARY_ENTRY, (entry, _options, theme) => {
		const data = entry.data as TurnSummaryData | undefined;
		if (!data || typeof data.durationMs !== "number") return undefined;
		return new Text(turnSummaryLine(data, theme), 0, 0);
	});

	pi.on("session_start", (event, ctx) => {
		config = loadConfig();
		activeCtx = ctx;
		fallbackTheme = ctx.hasUI ? ctx.ui.theme : fallbackTheme;
		runStartedAt = undefined;
		runTools = 0;
		seed(ctx);
		scheduleSeed(ctx);
		applyHeader(ctx, event.reason === "new");
		installSkillPatch(skillHooks);
		installUserMessagePatch(skillHooks);
		installUserShellPatch(userShellHooks);
		scheduleLiveThinking();
		scheduleSkillRefresh();
		requestRender();
	});

	pi.on("user_bash", () => {
		// Display only: returning nothing leaves execution to pi (or to another extension).
		scheduleUserShellRefresh();
		return undefined;
	});

	pi.on("agent_start", () => {
		cancelSeedTimers();
		runStartedAt ??= Date.now();
	});

	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		runTools++;
		if (!isManaged(event.toolName)) {
			timeline.closeCurrent();
			requestRender();
			return;
		}
		timeline.begin(event.toolCallId, event.toolName, event.args, Date.now(), config.tools.groupReadOnly);
		// Under fold the row exists since its arguments streamed; a running command's elapsed time
		// and its preview delay start when it runs (fold-more.md §5.8).
		timeline.startExecution(event.toolCallId, Date.now());
		if (timeline.foldEnabled && isShellTool(event.toolName)) scheduleRunningBlock(event.toolCallId);
		requestRender();
	});

	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		// The event carries the error flag beside the result; the timeline reads it from the result.
		const result = { ...(event.result ?? {}), isError: event.isError === true };
		if (timeline.row(event.toolCallId)) {
			timeline.end(event.toolCallId, result, Date.now());
		} else if (isManaged(event.toolName)) {
			timeline.begin(event.toolCallId, event.toolName, {}, Date.now(), config.tools.groupReadOnly);
			timeline.end(event.toolCallId, result, Date.now());
		}
		requestRender();
	});

	pi.on("tool_execution_update", (event) => {
		if (event.parentToolCallId) return;
		timeline.update(event.toolCallId, event.partialResult);
	});

	// Extensions hear message events before pi's interactive mode does, so blocks are placed in
	// segments before pi builds their tool rows, even while the assistant patch is not installed.
	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		timeline.ingestAssistant(event.message, true);
		if (!liveThinkingPatched) setTimeout(ensureLiveThinking, 0);
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		timeline.ingestAssistant(event.message, true);
		if (!liveThinkingPatched) ensureLiveThinking();
	});

	pi.on("message_end", (event) => {
		const ended = event.message as { role?: unknown; stopReason?: unknown; timestamp?: unknown };
		if (ended.role === "assistant" && ended.stopReason === "aborted" && typeof ended.timestamp === "number") {
			runAborted.push(ended.timestamp);
		}
		timeline.ingestAssistant(event.message, false);
		timeline.onMessage(event.message);
		if (event.message.role === "user") scheduleSkillRefresh([0, 50]);
		if (event.message.role === "assistant" && !liveThinkingPatched) ensureLiveThinking();
		requestRender();
	});

	pi.on("turn_end", () => {
		// A turn can end between two reads; keep the group open until text, a
		// mutation, a user message, or the whole run settles.
		requestRender();
	});

	pi.on("agent_settled", (event) => {
		timeline.closeCurrent();
		// The run is over: every segment it drew as a list collapses into its summary line, at the
		// same moment `✻ Worked for` appears (fold-more.md §4.10). A seed does the same at its end.
		timeline.settle();
		cancelRunningBlockTimers();
		const durationMs = runStartedAt === undefined ? 0 : Date.now() - runStartedAt;
		if (writesSummary()) {
			pi.appendEntry(TURN_SUMMARY_ENTRY, {
				durationMs,
				tools: runTools,
				aborted: event.aborted,
			} satisfies TurnSummaryData);
			// From now on the summary says it; the abort notes above give way on the next frame.
			if (event.aborted) for (const timestamp of runAborted) summarized.add(timestamp);
		}
		runAborted = [];
		runStartedAt = undefined;
		runTools = 0;
		if (reseedPending && activeCtx) refreshFold(activeCtx);
		requestRender();
	});

	pi.on("session_compact", () => {
		timeline.closeCurrent();
		timeline.closeSegment();
		requestRender();
	});

	pi.on("session_tree", (_event, ctx) => {
		runStartedAt = undefined;
		runTools = 0;
		seed(ctx);
		scheduleSeed(ctx);
		scheduleLiveThinking();
		scheduleSkillRefresh();
		requestRender();
	});

	pi.on("session_shutdown", () => {
		for (const timer of liveThinkingTimers) clearTimeout(timer);
		liveThinkingTimers = [];
		cancelSeedTimers();
		cancelSkillTimers();
		cancelUserShellTimers();
		cancelRunningBlockTimers();
		uninstallSkillPatches();
		uninstallUserMessagePatches();
		uninstallUserShellPatches();
		// The prototype patch outlives this module; leave pi's own method for the next load.
		uninstallThinkingPatches();
		liveThinkingPatched = false;
		headerCleanup?.();
		headerCleanup = undefined;
		activeTui = undefined;
		activeCtx = undefined;
		runStartedAt = undefined;
		runTools = 0;
		runAborted = [];
		timeline.reset();
	});

	// The /shizuku panel (pi-shizuku-settings) edits the same file /bettertui writes.
	exposeSettings(pi, {
		id: "pi-bettertui",
		title: "pi-bettertui",
		description: "Compact transcript: tool rows, activity folding, thinking window",
		file: getConfigPath(),
		items: () => settingsItems(config),
		set: (id, value) => {
			const result = applySetting(config, id, value);
			if ("error" in result) return { ok: false, error: result.error };
			try {
				saveConfig(result.config);
			} catch (error) {
				return { ok: false, error: `could not save config: ${String(error)}` };
			}
			config = result.config;
			if (activeCtx) applyConfigChange(activeCtx);
			return { ok: true };
		},
	});

	pi.registerCommand("bettertui", {
		description: "Configure pi-bettertui (status | on | off | header off|compact | thinking 0-5 | group on|off | tools on|off | describe on|off | shellfold on|off | summary on|off | fold on|off | reset)",
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const command = parts[0] ?? "status";
			const value = parts[1];
			let changed = false;
			switch (command) {
				case "on":
					config.enabled = true;
					changed = true;
					break;
				case "off":
					config.enabled = false;
					changed = true;
					break;
				case "header":
					if (value === "off" || value === "compact") {
						config.header = value;
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui header off|compact", "warning");
						return;
					}
					break;
				case "thinking": {
					const lines = Number(value);
					if (Number.isInteger(lines) && lines >= 0 && lines <= 5) {
						config.thinking.lines = lines;
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui thinking 0-5 (0 = native)", "warning");
						return;
					}
					break;
				}
				case "group":
					if (value === "on" || value === "off") {
						config.tools.groupReadOnly = value === "on";
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui group on|off", "warning");
						return;
					}
					break;
				case "tools":
					if (value === "on" || value === "off") {
						config.tools.compact = value === "on";
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui tools on|off", "warning");
						return;
					}
					break;
				case "summary":
					if (value === "on" || value === "off") {
						config.turnSummary = value === "on";
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui summary on|off", "warning");
						return;
					}
					break;
				case "fold":
					if (value === "on" || value === "off") {
						config.fold.enabled = value === "on";
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui fold on|off", "warning");
						return;
					}
					break;
				case "describe":
					if (value === "on" || value === "off") {
						config.tools.shellDescription = value === "on";
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui describe on|off (applies after /reload)", "warning");
						return;
					}
					break;
				case "shellfold":
					if (value === "on" || value === "off") {
						config.userShell.foldAnswered = value === "on";
						changed = true;
					} else {
						ctx.ui.notify("usage: /bettertui shellfold on|off", "warning");
						return;
					}
					break;
				case "reset":
					config = structuredClone(DEFAULT_CONFIG);
					changed = true;
					break;
				case "status":
					break;
				default:
					ctx.ui.notify(
						"usage: /bettertui [status|on|off|header off|compact|thinking 0-5|group on|off|tools on|off|describe on|off|shellfold on|off|summary on|off|fold on|off|reset]",
						"warning",
					);
					return;
			}

			if (changed) {
				try {
					saveConfig(config);
				} catch (error) {
					ctx.ui.notify(`pi-bettertui: could not save config: ${String(error)}`, "warning");
				}
				applyConfigChange(ctx);
			}
			ctx.ui.notify(`pi-bettertui: ${status()}`, "info");
		},
	});
}
