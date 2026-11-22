// Startup resource listing ([Context] / [Skills] / [Extensions] …) redrawn as one aligned table.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ResourceSection {
	/** Section name without brackets, e.g. "Skills". */
	label: string;
	items: string[];
}

/** Gap between the widest `[Label]` and the item column. */
const LABEL_GAP = 2;
/** Below this many columns for items, labels get their own line and items indent by two. */
const MIN_HANGING_WIDTH = 24;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Read one of pi's collapsed sections: a `[Label]` line followed by a single line of
 * comma-separated names. Anything else (warnings, expanded path listings) is not a section.
 */
export function parseSection(text: string): ResourceSection | undefined {
	const plain = text.replace(ANSI, "");
	const newline = plain.indexOf("\n");
	if (newline < 0) return undefined;
	const head = /^\[([^\]]+)\]$/.exec(plain.slice(0, newline).trim());
	const body = plain.slice(newline + 1);
	if (!head?.[1] || body.includes("\n")) return undefined;
	const items = body
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	if (items.length === 0) return undefined;
	const label = head[1];
	return { label, items: label === "Extensions" ? items.map(shortenExtension) : items };
}

/** `pi-hud/src` says nothing `pi-hud` does not; pi keeps the folder of a local `src/index.ts`. */
function shortenExtension(item: string): string {
	return item.replace(/\/src$/, "");
}

/**
 * Lay sections out as `[Label]  a, b, c` with items wrapping under the item column.
 * Every label pads to the widest one so the item columns line up.
 */
export function layoutSections(sections: readonly ResourceSection[], width: number, theme: Theme): string[] {
	if (sections.length === 0 || width <= 0) return [];
	const column = Math.max(...sections.map((section) => visibleWidth(`[${section.label}]`))) + LABEL_GAP;
	const hanging = width - column >= MIN_HANGING_WIDTH;
	const indent = hanging ? column : 2;
	const lines: string[] = [];
	for (const section of sections) {
		const head = `[${section.label}]`;
		const rows = wrapItems(section.items, width - indent);
		if (!hanging) {
			lines.push(truncateToWidth(theme.fg("mdHeading", head), width, "…"));
			for (const row of rows) lines.push(`${" ".repeat(indent)}${theme.fg("dim", row)}`);
			continue;
		}
		rows.forEach((row, index) => {
			const prefix = index === 0
				? `${theme.fg("mdHeading", head)}${" ".repeat(column - visibleWidth(head))}`
				: " ".repeat(column);
			lines.push(`${prefix}${theme.fg("dim", row)}`);
		});
	}
	return lines;
}

/** Greedy wrap that only breaks between items; a line that breaks keeps its trailing comma. */
export function wrapItems(items: readonly string[], width: number): string[] {
	if (width <= 0) return [];
	const rows: string[] = [];
	let current = "";
	items.forEach((item, index) => {
		const token = index < items.length - 1 ? `${item},` : item;
		const candidate = current ? `${current} ${token}` : token;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			return;
		}
		if (current) rows.push(current);
		current = visibleWidth(token) > width ? truncateToWidth(token, width, "…") : token;
	});
	if (current) rows.push(current);
	return rows;
}
