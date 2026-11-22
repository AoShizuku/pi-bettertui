/**
 * The line at the top of the transcript after `/new` or `/clear` (DESIGN.md §10): a titled rule
 * `─ New session · 14:32 ───…─` in place of pi's `✓ New session started` and pi-clear's notice.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The confirmations pi (`/new`) and pi-clear (`/clear`) leave in the cleared transcript. */
const CONFIRMATION = /^(?:✓\s*)?new session(?: started)?$/i;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;:]*m/g;

interface ContainerLike {
	children: unknown[];
}

/** `─ New session · 14:32 ───…─`: rule in borderMuted, label muted from column 2 (design_style.md §4.1). */
export class SessionDivider implements Component {
	private readonly label: string;

	constructor(
		private readonly getTheme: () => Theme,
		startedAt: Date = new Date(),
	) {
		this.label = `New session · ${clock(startedAt)}`;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.getTheme();
		return [titledRule(width, (rule) => theme.fg("borderMuted", rule), theme.fg("muted", this.label))];
	}

	invalidate(): void {}
}

function clock(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The top of one new session's transcript. The header runs `update` from the transcript's render
 * whenever its children change (DESIGN.md §10.3), so a confirmation line is gone before the frame
 * that would show it: pi writes its line once `newSession()` returns, pi-clear from its
 * `withSession` callback, both after `session_start`.
 */
export class SessionDividerSlot {
	private placed = false;
	private done = false;

	constructor(readonly divider: SessionDivider) {}

	/**
	 * Put the divider at the top once, then drop confirmation lines among the leading blank lines and
	 * texts, each with the blank line pi puts above it. A line this does not recognise (another pi
	 * version's wording, another extension's notice) stays below the divider. Once pi clears the
	 * transcript again (`/tree`, a rebuild), the divider is gone and the slot stops for good.
	 * Returns whether the transcript changed.
	 */
	update(chat: ContainerLike): boolean {
		if (this.done) return false;
		const children = chat.children;
		let changed = false;
		if (!this.placed) {
			children.unshift(this.divider);
			this.placed = true;
			changed = true;
		} else if (children[0] !== this.divider) {
			this.done = true;
			return false;
		}
		// Only the run of blank lines and texts right under the divider: the first message ends it,
		// so a long transcript costs a few checks.
		for (let index = 1; index < children.length; index++) {
			const child = children[index];
			if (isConfirmation(child)) {
				const above = index > 1 && isBlankLine(children[index - 1]) ? 1 : 0;
				children.splice(index - above, 1 + above);
				index -= above + 1;
				changed = true;
			} else if (!isBlankLine(child) && !isText(child)) {
				break;
			}
		}
		return changed;
	}
}

/** A plain text line (pi's Text / ThemedText), as opposed to a message or a container. */
function isText(value: unknown): boolean {
	return !!value && typeof value === "object" && "text" in value && !("children" in value);
}

/** A single-line text whose words are a new-session confirmation. ThemedText keeps them in `build`. */
function isConfirmation(value: unknown): boolean {
	const candidate = value as { text?: unknown; build?: unknown } | null;
	if (!candidate || typeof candidate !== "object" || !("text" in candidate)) return false;
	let text: unknown = candidate.text;
	if (typeof candidate.build === "function") {
		try {
			text = (candidate.build as () => unknown).call(candidate);
		} catch {
			return false;
		}
	}
	return typeof text === "string" && CONFIRMATION.test(text.replace(ANSI, "").trim());
}

/** pi's Spacer: a blank-line component with no content of its own. */
function isBlankLine(value: unknown): boolean {
	const candidate = value as { setLines?: unknown } | null;
	return !!candidate && typeof candidate.setLines === "function" && !("text" in candidate) && !("children" in candidate);
}

/**
 * A titled rule, `─ left ───── right ─`, the full width (design_style.md §4.1): a bottom panel's top edge, and
 * the same shape for a divider inside a panel. Labels come in already colored; only the rule is painted here.
 * When the row is narrow the fill shrinks to one `─` first, then each right label is tried in turn (full form,
 * then shorter ones) and finally dropped, and last the left label is cut with `…`. The leading `─ ` and the
 * closing `─` always stay.
 */
export function titledRule(
	width: number,
	paint: (rule: string) => string,
	left: string,
	right: string | readonly string[] = [],
): string {
	const rule = (count: number) => paint("─".repeat(count));
	if (width < 4) return rule(Math.max(0, width));
	const leftWidth = visibleWidth(left);
	for (const label of typeof right === "string" ? [right] : right) {
		// `─ ` left ` ` fill ` ` right ` ─`
		const fill = width - leftWidth - visibleWidth(label) - 6;
		if (label && fill >= 1) return `${rule(1)} ${left} ${rule(fill)} ${label} ${rule(1)}`;
	}
	const shown = leftWidth <= width - 4 ? left : truncateToWidth(left, width - 4, "…");
	return `${rule(1)} ${shown} ${rule(width - 3 - visibleWidth(shown))}`;
}
