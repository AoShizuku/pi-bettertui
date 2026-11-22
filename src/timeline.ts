import { isFailed, isInterrupted, isManagedTool, isMergeableTool, isShellTool, skillReadName, targetKey } from "./tool-summary.js";
import type { ToolContentBlock, ToolResultSnapshot } from "./types.js";
import { argsOf, str } from "./format.js";
import { classifyBlock, FOLD_OFF, type FoldPolicy, type FoldStats, thinkingAnchor, thinkingRuns } from "./segment.js";

export interface ToolRow {
	id: string;
	name: string;
	args: Record<string, unknown>;
	group?: ToolGroup;
	standalone: boolean;
	expanded: boolean;
	startedAt: number;
	/** When the call started running, as opposed to when its arguments started streaming. */
	execStartedAt?: number;
	endedAt?: number;
	result?: ToolResultSnapshot;
	partialText: string;
	invalidate?: () => void;
	lastInvalidateAt: number;
	version: number;
}

export interface ToolGroup {
	id: string;
	members: ToolRow[];
	expanded: boolean;
	closed: boolean;
	startedAt: number;
	endedAt?: number;
}

/** A thinking run inside a segment; its text is refreshed on every update of its message. */
export interface SegThinkingItem {
	kind: "thinking";
	anchor: string;
	msgTs: number;
	run: number;
	text: string;
	streaming: boolean;
	/**
	 * Measured live only (fold-more.md §5.5): when the run was first seen (its message's timestamp
	 * when the run opens the message), and when it stopped growing — the next block of its message
	 * appeared, or the message ended. A seed has no clock to read and leaves both unset.
	 */
	startedAt?: number;
	endedAt?: number;
	/** Runs with text in the message so far, and the message's `durationMs`; the fallback when nothing was measured. */
	messageRuns: number;
	messageDurationMs?: number;
}

/**
 * How long a finished thinking run took, for its line in the list: what was measured live, else
 * its message's `durationMs` when the message holds only this run. A message with several runs
 * cannot split its duration among them, so those get none (`Thought`).
 */
export function thoughtDuration(item: SegThinkingItem): number | undefined {
	if (item.startedAt !== undefined && item.endedAt !== undefined) return Math.max(0, item.endedAt - item.startedAt);
	return item.messageRuns === 1 ? item.messageDurationMs : undefined;
}

export interface SegToolItem {
	kind: "tool";
	/** The tool call id. */
	anchor: string;
	name: string;
}

export type SegItem = SegThinkingItem | SegToolItem;

/**
 * A run of thinking and non-changing tool calls between two boundaries (fold-more.md §5.1).
 * Items keep the model's real output order across assistant messages.
 */
export interface Segment {
	id: string;
	items: SegItem[];
	/** The first anchor; it draws the whole segment and never changes. */
	host: string;
	/** No more items join: a boundary came. The segment still draws as a list until it collapses. */
	closed: boolean;
	/**
	 * Drawn as one summary line instead of the list: set for every segment of a run once the run
	 * settles, never in the middle of one (fold-more.md §4.10).
	 */
	collapsed: boolean;
	/** A collapsed segment opened again into its list. */
	expanded: boolean;
	/** Items whose details are open in the list. */
	expandedItems: Set<string>;
	/** Messages that put thinking into this segment: timestamp → duration, counted once each. */
	thinkingMsgs: Map<number, { durationMs?: number; streaming: boolean }>;
}

export type FoldRole =
	| { kind: "single"; segment?: Segment }
	| { kind: "host"; segment: Segment }
	| { kind: "hidden"; segment: Segment };

/** Session entry types that end a segment besides messages; extension state entries do not. */
const SEGMENT_CLOSING_ENTRIES = new Set(["compaction", "branch_summary", "custom_message"]);

interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	durationMs?: number;
}

function asMessage(value: unknown): MessageLike | undefined {
	return typeof value === "object" && value !== null ? (value as MessageLike) : undefined;
}

export function hasVisibleText(message: MessageLike | undefined): boolean {
	if (!message) return false;
	if (typeof message.content === "string") return message.content.trim().length > 0;
	if (!Array.isArray(message.content)) return false;
	return message.content.some((item) => {
		if (!item || typeof item !== "object") return false;
		const block = item as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
	});
}

function snapshot(value: unknown): ToolResultSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const message = value as {
		content?: unknown;
		details?: unknown;
		isError?: unknown;
		durationMs?: unknown;
	};
	const content: ToolContentBlock[] = [];
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const item = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
			if (item.type === "text" && typeof item.text === "string") {
				content.push({ type: "text", text: item.text });
			} else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
				content.push({ type: "image", data: item.data, mimeType: item.mimeType });
			}
		}
	}
	return {
		content,
		details: message.details,
		isError: message.isError === true,
		durationMs: typeof message.durationMs === "number" ? message.durationMs : undefined,
	};
}

/**
 * Timeline of compact transcript rows. It owns grouping and boundaries only;
 * rendering lives in tool-row.ts. This keeps resume and live rendering
 * deterministic from the same model.
 */
export class ActivityTimeline {
	private rows = new Map<string, ToolRow>();
	private groups = new Map<string, ToolGroup>();
	private current?: ToolGroup;
	private sequence = 0;
	epoch = 0;

	// Fold (fold-more.md §5.9). Off by default, so read-only groups work as before.
	private fold: FoldPolicy = FOLD_OFF;
	private segments = new Map<string, Segment>();
	private anchorOf = new Map<string, Segment>();
	private currentSegment?: Segment;
	/** Units already placed: an item, or a boundary that has already closed its segment. */
	private seenUnits = new Map<string, "item" | "boundary">();
	private ingested = new Set<number>();
	private latestMessage = Number.NEGATIVE_INFINITY;
	private seeding = false;
	/** pi's Ctrl+O state, recorded by tool rows so thinking hosts can follow it too. */
	globalExpanded = false;
	/** pi's Ctrl+T state ("show thinking details"), recorded by the thinking patch. */
	thinkingDetails = false;
	/** Called when a segment hosted by a thinking run changes; there is no tool row to invalidate. */
	onFoldChange?: () => void;

	reset(): void {
		this.rows.clear();
		this.groups.clear();
		this.current = undefined;
		this.sequence = 0;
		this.segments.clear();
		this.anchorOf.clear();
		this.currentSegment = undefined;
		this.seenUnits.clear();
		this.ingested.clear();
		this.latestMessage = Number.NEGATIVE_INFINITY;
		this.epoch++;
	}

	/** Takes effect for what is ingested next; callers reseed after changing it. */
	setFoldPolicy(policy: FoldPolicy): void {
		this.fold = policy;
	}

	get foldEnabled(): boolean {
		return this.fold.enabled;
	}

	get foldPolicy(): FoldPolicy {
		return this.fold;
	}

	/** Invalidate callbacks of every row, so a reseed can make pi rebuild their components. */
	rowInvalidators(): Array<() => void> {
		return [...this.rows.values()].flatMap((row) => (row.invalidate ? [row.invalidate] : []));
	}

	bumpEpoch(): void {
		this.epoch++;
	}

	begin(id: string, name: string, args: unknown, at = Date.now(), merge = true): ToolRow {
		const existing = this.rows.get(id);
		if (existing) return existing;

		const row: ToolRow = {
			id,
			name,
			args: argsOf(args),
			standalone: true,
			expanded: false,
			startedAt: at,
			partialText: "",
			lastInvalidateAt: 0,
			version: 0,
		};
		this.rows.set(id, row);

		// Fold replaces read-only groups; ingestAssistant builds segments instead.
		if (this.fold.enabled) return row;
		if (!merge || !isMergeableTool(name) || !isManagedTool(name) || skillReadName(name, row.args)) {
			this.closeCurrent();
			return row;
		}

		if (!this.current || this.current.closed) {
			const group: ToolGroup = {
				id: `g:${id}`,
				members: [row],
				expanded: false,
				closed: false,
				startedAt: at,
			};
			this.current = group;
			this.groups.set(group.id, group);
			row.group = group;
			row.standalone = false;
		} else {
			const group = this.current;
			group.members.push(row);
			group.endedAt = undefined;
			row.group = group;
			row.standalone = false;
		}
		return row;
	}

	/**
	 * A call's arguments stream in after its row exists, so a read can join a group
	 * before its path shows it loads a skill. Move such a row out to stand alone, and
	 * close the group so later reads do not merge into a row drawn above it.
	 */
	detachSkillRead(id: string): boolean {
		const row = this.rows.get(id);
		const group = row?.group;
		if (!row || !group || !skillReadName(row.name, row.args)) return false;
		const index = group.members.indexOf(row);
		if (index >= 0) group.members.splice(index, 1);
		row.group = undefined;
		row.standalone = true;
		if (group.members.length === 0) {
			this.groups.delete(group.id);
			if (this.current === group) this.current = undefined;
		} else {
			if (this.current === group) this.closeCurrent(false);
			this.touchGroup(group);
		}
		row.invalidate?.();
		return true;
	}

	end(id: string, result: unknown, at = Date.now()): ToolRow | undefined {
		const row = this.rows.get(id);
		if (!row) return undefined;
		row.endedAt = at;
		row.result = snapshot(result);
		row.partialText = "";
		row.version++;
		if (row.group) {
			row.group.endedAt = Math.max(row.group.endedAt ?? 0, at);
		}
		this.touch(row);
		return row;
	}

	setResult(id: string, result: unknown, at = Date.now()): ToolRow | undefined {
		const row = this.rows.get(id);
		if (!row) return undefined;
		row.endedAt = at;
		row.result = snapshot(result);
		row.partialText = "";
		row.version++;
		if (row.group) row.group.endedAt = Math.max(row.group.endedAt ?? 0, at);
		return row;
	}

	update(id: string, partialResult: unknown, now = Date.now()): void {
		const row = this.rows.get(id);
		if (!row || row.endedAt !== undefined) return;
		const text = partialText(partialResult);
		if (text === undefined) return;
		row.partialText = text;
		row.version++;
		if (now - row.lastInvalidateAt < 100) return;
		row.lastInvalidateAt = now;
		this.touch(row);
	}

	/**
	 * A call starts running. Under fold its elapsed time counts from here, not from when its
	 * arguments started streaming, which matters once parallel commands sit side by side; the
	 * preview block's one-second delay counts from here in both modes (fold-more.md §5.8).
	 */
	startExecution(id: string, at = Date.now()): ToolRow | undefined {
		const row = this.rows.get(id);
		if (!row || row.endedAt !== undefined) return row;
		if (this.fold.enabled) row.startedAt = at;
		row.execStartedAt ??= at;
		return row;
	}

	refresh(id: string): void {
		const row = this.rows.get(id);
		if (row) this.touch(row);
	}

	/**
	 * Redraw the host of the fold segment `id` belongs to, unless `id` is the host itself. Never
	 * invalidates `id`'s own row, so it is safe to call from that row's renderer.
	 */
	refreshHost(id: string): void {
		const segment = this.fold.enabled ? this.anchorOf.get(id) : undefined;
		if (segment && segment.host !== id) this.touchSegment(segment);
	}

	attach(id: string, invalidate: () => void): ToolRow | undefined {
		const row = this.rows.get(id);
		if (!row) return undefined;
		row.invalidate = invalidate;
		return row;
	}

	row(id: string): ToolRow | undefined {
		return this.rows.get(id);
	}

	group(id: string): ToolGroup | undefined {
		return this.groups.get(id);
	}

	groupsList(): ToolGroup[] {
		return [...this.groups.values()];
	}

	onMessage(message: unknown): void {
		const value = asMessage(message);
		if (!value) return;
		if (value.role === "user") {
			this.closeCurrent();
			this.closeSegment();
			return;
		}
		if (value.role === "toolResult") return;
		if (value.role !== "assistant") {
			// Custom and user-shell messages sit between segments like a user message does.
			this.closeSegment();
			return;
		}
		if (hasVisibleText(value) || value.stopReason === "error" || value.stopReason === "aborted") {
			this.closeCurrent();
		}
	}

	closeCurrent(settled = true): void {
		if (!this.current) return;
		const group = this.current;
		group.closed = true;
		if (settled) group.endedAt ??= Date.now();
		this.current = undefined;
		this.touchGroup(group);
	}

	toggleGroup(group: ToolGroup): void {
		group.expanded = !group.expanded;
		this.touchGroup(group);
	}

	toggleRow(row: ToolRow): void {
		row.expanded = !row.expanded;
		row.invalidate?.();
	}

	private touch(row: ToolRow): void {
		const segment = this.fold.enabled ? this.anchorOf.get(row.id) : undefined;
		if (segment) {
			this.touchSegment(segment);
			if (segment.host !== row.id) row.invalidate?.();
			return;
		}
		if (row.group) {
			this.touchGroup(row.group);
			return;
		}
		row.invalidate?.();
	}

	private touchGroup(group: ToolGroup): void {
		const owner = group.members[0];
		owner?.invalidate?.();
	}

	private touchSegment(segment: Segment): void {
		const host = this.rows.get(segment.host);
		if (host?.invalidate) host.invalidate();
		else this.onFoldChange?.();
	}

	/**
	 * Rebuild groups from persisted entries. A rendered transcript is not
	 * guaranteed to emit live tool events, so resume must be deterministic.
	 */
	seed(entries: readonly unknown[], merge = true, manage: (name: string) => boolean = isManagedTool): void {
		this.reset();
		this.seeding = true;
		try {
			this.seedEntries(entries, merge, manage);
		} finally {
			this.seeding = false;
		}
	}

	private seedEntries(entries: readonly unknown[], merge: boolean, manage: (name: string) => boolean): void {
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as { type?: unknown; message?: unknown };
			if (record.type !== "message") {
				this.closeCurrent();
				if (typeof record.type === "string" && SEGMENT_CLOSING_ENTRIES.has(record.type)) this.closeSegment();
				continue;
			}
			const message = asMessage(record.message);
			if (!message) continue;
			const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();

			if (message.role === "user") {
				this.closeCurrent();
				this.closeSegment();
				continue;
			}

			if (message.role === "assistant") {
				if (hasVisibleText(message)) this.closeCurrent();
				if (!Array.isArray(message.content)) continue;
				for (const item of message.content) {
					if (!item || typeof item !== "object") continue;
					const block = item as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
					if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") {
						continue;
					}
					if (!manage(block.name)) {
						this.closeCurrent();
						continue;
					}
					this.begin(block.id, block.name, block.arguments, timestamp, merge);
				}
				// The same entry point as streaming, so a resumed session folds the same way.
				this.ingestAssistant(message, false, timestamp);
				continue;
			}

			if (message.role === "toolResult" && typeof message.toolCallId === "string") {
				this.end(message.toolCallId, message, timestamp);
			} else if (message.role !== "toolResult") {
				this.closeSegment();
			}
		}
		this.closeCurrent();
		// A seed only runs while no run is going on (session start, tree navigation, a config
		// change after the run settled), so every run in the history has ended by now: collapse
		// all of it, as agent_settled did live. A run cut off by a crash collapses too.
		this.settle();
	}

	// -----------------------------------------------------------------------
	// Fold segments
	// -----------------------------------------------------------------------

	/**
	 * Place the blocks of an assistant message into segments (fold-more.md §5.1). Called with
	 * every streaming snapshot and once more at the end; idempotent: blocks seen before only
	 * refresh (thinking text, streaming state), new blocks are appended in content order.
	 *
	 * The one change to an earlier decision: a shell command or read joins while its arguments
	 * stream; once they are complete and show a change or a skill load, it leaves its segment
	 * again and closes it. It is always the newest item then, so no other item moves.
	 */
	ingestAssistant(message: unknown, streaming: boolean, at = Date.now()): void {
		if (!this.fold.enabled) return;
		const value = asMessage(message);
		if (!value || value.role !== "assistant" || typeof value.timestamp !== "number") return;
		const ts = value.timestamp;
		const known = this.ingested.has(ts);
		// Outside a seed, a message older than the newest one seen only refreshes what is already
		// placed: history belongs to the seed, and appending would put old blocks after newer ones.
		// The seed walks entries in session order, whatever their timestamps say.
		if (!known && ts < this.latestMessage && !this.seeding) return;
		if (!known) {
			this.ingested.add(ts);
			this.latestMessage = Math.max(this.latestMessage, ts);
		}
		const grow = this.seeding || ts >= this.latestMessage;
		const content: unknown[] = Array.isArray(value.content) ? value.content : [];
		const last = content.length - 1;
		const runs = new Map(thinkingRuns(content).map((run) => [run.firstBlock, run]));
		const durationMs = typeof value.durationMs === "number" ? value.durationMs : undefined;
		// Thinking runs time themselves only while they stream in front of us.
		const measure = streaming && !this.seeding;

		for (let index = 0; index < content.length; index++) {
			const block = content[index];
			if (!block || typeof block !== "object") continue;
			const type = (block as { type?: unknown }).type;
			if (type === "thinking") {
				const run = runs.get(index);
				if (!run) continue;
				index = run.lastBlock;
				const anchor = thinkingAnchor(ts, run.runIndex);
				if (classifyBlock({ type: "thinking", thinking: run.text }, this.fold) !== "fold") {
					this.placeBoundary(anchor, grow);
					continue;
				}
				const segment = this.placeItem(anchor, grow, () => ({
					kind: "thinking",
					anchor,
					msgTs: ts,
					run: run.runIndex,
					text: run.text,
					streaming: false,
					// The first run of a message counts from the message's start, like its durationMs.
					startedAt: measure ? (run.firstBlock === 0 ? Math.min(ts, at) : at) : undefined,
					messageRuns: runs.size,
				}));
				const item = segment?.items.find((entry) => entry.anchor === anchor);
				if (segment && item?.kind === "thinking") {
					item.text = run.text;
					item.streaming = streaming && run.lastBlock === last;
					if (item.startedAt !== undefined && item.endedAt === undefined && !item.streaming) {
						item.endedAt = Math.max(item.startedAt, at);
					}
					item.messageRuns = runs.size;
					item.messageDurationMs = durationMs;
					segment.thinkingMsgs.set(ts, { durationMs, streaming });
				}
				continue;
			}
			if (type === "toolCall") {
				const call = block as { id?: unknown; name?: unknown; arguments?: unknown };
				const id = call.id;
				if (typeof id !== "string") continue;
				const name = typeof call.name === "string" ? call.name : "";
				if (name && this.fold.manage(name)) {
					const row = this.begin(id, name, call.arguments, at, false);
					row.args = argsOf(call.arguments);
				}
				const kind = classifyBlock(block, this.fold, !streaming || index < last);
				if (kind === "fold") this.placeItem(id, grow, () => ({ kind: "tool", anchor: id, name }));
				else this.placeBoundary(id, grow);
				continue;
			}
			if (classifyBlock(block, this.fold) === "text") this.placeBoundary(`msg:${ts}!${index}`, grow);
		}

		if (!streaming && (value.stopReason === "error" || value.stopReason === "aborted")) {
			this.placeBoundary(`msg:${ts}!stop`, grow);
		}
	}

	private placeItem(anchor: string, grow: boolean, create: () => SegItem): Segment | undefined {
		const seen = this.seenUnits.get(anchor);
		if (seen === "item") return this.anchorOf.get(anchor);
		if (seen === "boundary" || !grow) return undefined;
		let segment = this.currentSegment;
		if (!segment) {
			segment = {
				id: `seg:${anchor}`,
				items: [],
				host: anchor,
				closed: false,
				collapsed: false,
				expanded: false,
				expandedItems: new Set(),
				thinkingMsgs: new Map(),
			};
			this.segments.set(segment.id, segment);
			this.currentSegment = segment;
		}
		segment.items.push(create());
		this.anchorOf.set(anchor, segment);
		this.seenUnits.set(anchor, "item");
		this.touchSegment(segment);
		return segment;
	}

	private placeBoundary(key: string, grow: boolean): void {
		const seen = this.seenUnits.get(key);
		if (seen === "boundary") return;
		if (seen === "item") {
			this.detach(key);
			return;
		}
		if (!grow) return;
		this.seenUnits.set(key, "boundary");
		this.closeSegment();
	}

	/** Take a provisional item back out of its segment and close the segment (§5.2). */
	private detach(anchor: string): void {
		this.seenUnits.set(anchor, "boundary");
		const segment = this.anchorOf.get(anchor);
		this.anchorOf.delete(anchor);
		if (!segment) return;
		segment.items = segment.items.filter((item) => item.anchor !== anchor);
		segment.expandedItems.delete(anchor);
		if (segment.items.length === 0) {
			this.segments.delete(segment.id);
			if (this.currentSegment === segment) this.currentSegment = undefined;
		} else if (this.currentSegment === segment) {
			this.closeSegment();
		} else {
			this.touchSegment(segment);
		}
		this.rows.get(anchor)?.invalidate?.();
	}

	/**
	 * End the open segment: text, a change, a user message, compaction, or the run settling.
	 * A closed segment keeps drawing as a list; only `settle` collapses it.
	 */
	closeSegment(): void {
		const segment = this.currentSegment;
		if (!segment) return;
		segment.closed = true;
		this.currentSegment = undefined;
		this.touchSegment(segment);
	}

	/**
	 * The run settled (agent_settled live, the end of a seed): close the open segment and
	 * collapse every segment still drawn as a list into its summary line (fold-more.md §4.10).
	 * Segments the user opened during the run collapse too, and their item details close.
	 */
	settle(): void {
		this.closeSegment();
		for (const segment of this.segments.values()) {
			if (segment.collapsed) continue;
			segment.collapsed = true;
			segment.expanded = false;
			segment.expandedItems.clear();
			this.touchSegment(segment);
		}
	}

	segment(anchor: string): Segment | undefined {
		return this.anchorOf.get(anchor);
	}

	segmentsList(): Segment[] {
		return [...this.segments.values()];
	}

	/**
	 * What the slot of `anchor` draws (fold-more.md §5.6): itself when its segment is below the
	 * threshold, everything when it is the host, nothing otherwise. Derived on every render.
	 */
	foldRole(anchor: string): FoldRole {
		const segment = this.fold.enabled ? this.anchorOf.get(anchor) : undefined;
		if (!segment || segment.items.length < this.fold.minItems) return { kind: "single", segment };
		return segment.host === anchor ? { kind: "host", segment } : { kind: "hidden", segment };
	}

	toggleSegment(segment: Segment): void {
		segment.expanded = !segment.expanded;
		this.touchSegment(segment);
	}

	toggleSegmentItem(segment: Segment, anchor: string): void {
		if (segment.expandedItems.has(anchor)) segment.expandedItems.delete(anchor);
		else segment.expandedItems.add(anchor);
		this.touchSegment(segment);
	}

	/** Counts and tenses for the summary line (fold-more.md §5.4). */
	segmentStats(segment: Segment, now = Date.now()): FoldStats {
		let thinkingCount = 0;
		let thinkingActive = false;
		let commands = 0;
		let commandsActive = false;
		const readTargets = new Set<string>();
		let readCalls = 0;
		let searches = 0;
		let lists = 0;
		let exploreActive = false;
		let tools = 0;
		let failed = 0;
		let interrupted = 0;
		for (const item of segment.items) {
			if (item.kind === "thinking") {
				thinkingCount++;
				if (item.streaming) thinkingActive = true;
				continue;
			}
			tools++;
			const row = this.rows.get(item.anchor);
			const name = row?.name ?? item.name;
			const active = !row || row.endedAt === undefined;
			if (isFailed(row?.result)) failed++;
			else if (isInterrupted(row?.result)) interrupted++;
			if (isShellTool(name)) {
				commands++;
				if (active) commandsActive = true;
				continue;
			}
			if (active) exploreActive = true;
			if (name === "read") {
				readCalls++;
				readTargets.add(targetKey(name, row?.args ?? {}, item.anchor));
			} else if (name === "grep" || name === "find") {
				searches++;
			} else if (name === "ls") {
				lists++;
			}
		}
		let ms: number | undefined;
		for (const [ts, entry] of segment.thinkingMsgs) {
			const value = entry.durationMs ?? (entry.streaming ? Math.max(0, now - ts) : undefined);
			if (value !== undefined) ms = (ms ?? 0) + value;
		}
		return {
			thinking: { count: thinkingCount, ms, active: thinkingActive },
			commands: { count: commands, active: commandsActive },
			reads: readTargets.size || readCalls,
			searches,
			lists,
			exploreActive,
			tools,
			failed,
			interrupted,
		};
	}

	/** Partition of anchors into segments, for tests and debugging. */
	foldSnapshot(): Array<{ host: string; items: string[]; closed: boolean; collapsed: boolean }> {
		return this.segmentsList().map((segment) => ({
			host: segment.host,
			items: segment.items.map((item) => item.anchor),
			closed: segment.closed,
			collapsed: segment.collapsed,
		}));
	}
}

export interface GroupCounts {
	calls: number;
	reads: number;
	searches: number;
	lists: number;
}

export function groupCounts(group: ToolGroup): GroupCounts {
	const readTargets = new Set<string>();
	let readCalls = 0;
	let searches = 0;
	let lists = 0;
	for (const member of group.members) {
		if (member.name === "read") {
			readCalls++;
			readTargets.add(targetKey(member.name, member.args, member.id));
		} else if (member.name === "grep" || member.name === "find") {
			searches++;
		} else if (member.name === "ls") {
			lists++;
		}
	}
	return {
		calls: group.members.length,
		reads: readTargets.size || readCalls,
		searches,
		lists,
	};
}

export function groupActive(group: ToolGroup): boolean {
	return group.members.some((member) => member.endedAt === undefined);
}

/** Members that failed; an interrupted call is not a failure (DESIGN.md §9). */
export function groupFailed(group: ToolGroup): number {
	return group.members.filter((member) => isFailed(member.result)).length;
}

/** Members cut short by an interrupt. */
export function groupInterrupted(group: ToolGroup): number {
	return group.members.filter((member) => isInterrupted(member.result)).length;
}

export function groupEndedAt(group: ToolGroup): number {
	return group.endedAt ?? Math.max(...group.members.map((member) => member.endedAt ?? member.startedAt));
}

export function groupKind(group: ToolGroup): "reads" | "searches" | "lists" | "mixed" {
	const counts = groupCounts(group);
	const kinds = Number(counts.reads > 0) + Number(counts.searches > 0) + Number(counts.lists > 0);
	if (kinds > 1) return "mixed";
	if (counts.searches > 0) return "searches";
	if (counts.lists > 0) return "lists";
	return "reads";
}

export function groupAction(group: ToolGroup): string {
	const active = groupActive(group);
	switch (groupKind(group)) {
		case "mixed":
			return active ? "Exploring" : "Explored";
		case "searches":
			return active ? "Searching" : "Searched";
		case "lists":
			return active ? "Listing" : "Listed";
		default:
			return active ? "Reading" : "Read";
	}
}

export function groupSummary(group: ToolGroup): string {
	const counts = groupCounts(group);
	const parts: string[] = [];
	if (counts.reads > 0) parts.push(`${counts.reads} file${counts.reads === 1 ? "" : "s"}`);
	if (counts.searches > 0) parts.push(`${counts.searches} search${counts.searches === 1 ? "" : "es"}`);
	if (counts.lists > 0) parts.push(`${counts.lists} dir${counts.lists === 1 ? "" : "s"}`);
	return parts.join(", ");
}

export function groupDuration(group: ToolGroup, now = Date.now()): number {
	const end = groupActive(group) ? now : groupEndedAt(group);
	return Math.max(0, end - group.startedAt);
}

function partialText(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const item = block as { type?: unknown; text?: unknown };
			return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n");
	return str(text);
}
