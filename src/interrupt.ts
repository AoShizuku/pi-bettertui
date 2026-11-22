/**
 * The interrupt note under an aborted assistant message (DESIGN.md §9). pi draws a red
 * `Operation aborted` there; the turn summary below already says `✻ Interrupted after …`, so the
 * note gives way to it, and without a summary it becomes a warning-colored `Interrupted`.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

import { GUTTER } from "./gutter.js";

/** What pi writes for a plain interrupt; any other abort text carries information of its own. */
export const DEFAULT_ABORT_TEXT = "Operation aborted";

const PAD = " ".repeat(GUTTER);

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;:]*m/g;

interface AbortedMessage {
	stopReason?: unknown;
	errorMessage?: unknown;
	timestamp?: unknown;
	content?: unknown;
}

/** The note pi draws under an aborted message without tool calls, or undefined when it draws none. */
export function abortNoteText(message: AbortedMessage | undefined): string | undefined {
	if (message?.stopReason !== "aborted") return undefined;
	const content = Array.isArray(message.content) ? message.content : [];
	// With tool calls pi puts the abort into the tool rows instead.
	if (content.some((block) => (block as { type?: unknown } | null)?.type === "toolCall")) return undefined;
	const error = typeof message.errorMessage === "string" ? message.errorMessage : "";
	return error && error !== "Request was aborted" ? error : DEFAULT_ABORT_TEXT;
}

export interface InterruptNoteHooks {
	/** Whether a `✻ Interrupted` summary follows the aborted message with this timestamp. */
	summaryFollows: (timestamp: number) => boolean;
	getTheme: () => Theme;
}

/** Replaces pi's blank line and abort note; decides on every render whether the summary took its place. */
export class InterruptNote implements Component {
	constructor(
		private readonly text: string,
		private readonly timestamp: number | undefined,
		private readonly hooks: InterruptNoteHooks,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.hooks.getTheme();
		const plain = this.text === DEFAULT_ABORT_TEXT;
		const summarized = this.timestamp !== undefined && this.hooks.summaryFollows(this.timestamp);
		let line: string;
		if (summarized) {
			// The summary says it; only a note with more to tell (retries) stays, dim.
			if (plain) return [];
			line = theme.fg("dim", this.text);
		} else {
			line = theme.fg("warning", "Interrupted") + (plain ? "" : theme.fg("dim", ` · ${this.text}`));
		}
		return ["", truncateToWidth(`${PAD}${line}`, width, "…")];
	}

	invalidate(): void {}
}

/**
 * Swap pi's `Spacer` + abort `Text` at the end of an assistant message for one InterruptNote.
 * pi rebuilds the children on every update, so this runs after each one; when the last child is
 * not the expected note (another pi version), nothing changes and pi's own note stays.
 */
export function replaceInterruptNote(component: any, message: AbortedMessage | undefined, hooks: InterruptNoteHooks): void {
	const text = abortNoteText(message);
	if (text === undefined) return;
	const children = component?.contentContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return;
	const index = children.length - 1;
	const note = children[index] as { text?: unknown } | undefined;
	if (typeof note?.text !== "string" || note.text.replace(ANSI, "").trim() !== text) return;
	const timestamp = typeof message?.timestamp === "number" ? message.timestamp : undefined;
	children[index] = new InterruptNote(text, timestamp, hooks);
	if (index > 0 && isBlankLine(children[index - 1])) children.splice(index - 1, 1);
}

/** pi's Spacer: a blank-line component with no content of its own. */
function isBlankLine(value: unknown): boolean {
	const candidate = value as { setLines?: unknown; text?: unknown; children?: unknown } | null;
	return !!candidate && typeof candidate.setLines === "function" && !("text" in candidate) && !("children" in candidate);
}

interface EntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: { role?: unknown; stopReason?: unknown; timestamp?: unknown };
}

/**
 * Timestamps of aborted assistant messages that a `✻ Interrupted` summary follows within the same
 * run, read from a session branch. A run ends at its summary; a user message starts the next one.
 */
export function summarizedInterrupts(entries: readonly unknown[], summaryType: string): Set<number> {
	const out = new Set<number>();
	let pending: number[] = [];
	for (const raw of entries) {
		const entry = raw as EntryLike | null;
		if (!entry) continue;
		if (entry.type === "message") {
			const message = entry.message;
			if (message?.role === "user") pending = [];
			else if (message?.role === "assistant" && message.stopReason === "aborted" && typeof message.timestamp === "number") {
				pending.push(message.timestamp);
			}
			continue;
		}
		if (entry.type === "custom" && entry.customType === summaryType) {
			if ((entry.data as { aborted?: unknown } | undefined)?.aborted === true) {
				for (const timestamp of pending) out.add(timestamp);
			}
			pending = [];
		}
	}
	return out;
}
