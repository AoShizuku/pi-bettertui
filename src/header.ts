import { type ExtensionContext, type Theme, keyHint, rawKeyHint, VERSION } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

import type { BetterTuiConfig } from "./config.js";
import { layoutSections, parseSection, type ResourceSection } from "./resources.js";
import { SessionDivider, SessionDividerSlot } from "./session-divider.js";

type Hints = (theme: Theme) => string;

interface SpacerLike {
	setLines(lines: number): void;
	lines?: unknown;
}

interface ContainerLike {
	children: unknown[];
	render(width: number): string[];
}

interface Attachment {
	spacers: Array<{ spacer: SpacerLike; lines: number }>;
	resources: ContainerLike | undefined;
	render: (width: number) => string[];
	/** The transcript's render override while a new-session slot is pending, and what it shadowed. */
	chat?: { container: ContainerLike; render: (width: number) => string[]; shadowed?: unknown };
}

/**
 * Replaces pi's startup header. pi frames the header with a blank line on each side and puts
 * the resource listing ([Context] / [Skills] / …) right below it, one blank line per section.
 * This collapses both into a version line and an aligned table (DESIGN.md §8).
 */
export class BetterHeader implements Component {
	private config: BetterTuiConfig;
	private getTheme: () => Theme;
	private tui: TUI | undefined;
	private hints: Hints;
	private attachment: Attachment | undefined;
	private newSession: SessionDividerSlot | undefined;

	constructor(
		config: BetterTuiConfig,
		getTheme: () => Theme,
		tui?: TUI,
		hints: Hints = defaultHints,
		newSession?: SessionDividerSlot,
	) {
		this.config = config;
		this.getTheme = getTheme;
		this.tui = tui;
		this.hints = hints;
		this.newSession = newSession;
	}

	render(width: number): string[] {
		this.attach();
		if (width <= 0 || this.config.header === "off") return [];
		const theme = this.getTheme();
		const brand = `${theme.bold(theme.fg("accent", "pi"))} ${theme.fg("dim", `v${VERSION}`)}`;
		const hints = this.hints(theme);
		return [truncateToWidth(hints ? `${brand}   ${hints}` : brand, width, "…")];
	}

	/** The resource listing as this header draws it; exposed for tests. */
	renderResources(container: ContainerLike, width: number): string[] {
		const sections: ResourceSection[] = [];
		const extras: Component[] = [];
		for (const child of container.children) {
			if (isSpacer(child)) continue;
			const section = readSection(child);
			// ctrl+o shows pi's full listing (paths grouped by scope); that stays pi's own layout.
			if (section === "expanded") return Object.getPrototypeOf(container).render.call(container, width);
			if (section) sections.push(section);
			else if (isComponent(child)) extras.push(child);
		}
		const lines = layoutSections(sections, width, this.getTheme());
		for (const extra of extras) {
			if (lines.length > 0) lines.push("");
			lines.push(...extra.render(width));
		}
		const versionLine = this.config.header !== "off";
		// One blank line under the version line, and one between the top block and the first message.
		if (versionLine && lines.length > 0) lines.unshift("");
		if (lines.length > 0 || versionLine) lines.push("");
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.detach();
	}

	/**
	 * pi only hands the header to setHeader; its spacers and the listing are siblings, so find
	 * them in the tree once this header is mounted (the first render).
	 */
	private attach(): void {
		if (this.attachment || !this.tui) return;
		const found = locate(this.tui, this);
		if (!found) return;
		const index = found.header.children.indexOf(this);
		const spacers = [found.header.children[index - 1], found.header.children[index + 1]]
			.filter(isSpacer)
			.map((spacer) => ({ spacer, lines: typeof spacer.lines === "number" ? spacer.lines : 1 }));
		for (const { spacer } of spacers) spacer.setLines(0);
		const resources = found.resources;
		const render = (width: number): string[] => this.renderResources(resources!, width);
		// An own property shadows Container.prototype.render; deleting it restores pi's layout.
		if (resources) resources.render = render;
		this.attachment = { spacers, resources, render };
		if (this.newSession && found.chat) this.attachment.chat = attachNewSession(found.chat, this.newSession);
		this.tui.requestRender();
	}

	private detach(): void {
		const attachment = this.attachment;
		if (!attachment) return;
		this.attachment = undefined;
		for (const { spacer, lines } of attachment.spacers) spacer.setLines(lines);
		const resources = attachment.resources as { render?: unknown } | undefined;
		if (resources && Object.hasOwn(resources, "render") && resources.render === attachment.render) {
			delete resources.render;
		}
		const chat = attachment.chat;
		if (chat && chat.container.render === chat.render) {
			if (chat.shadowed === undefined) delete (chat.container as { render?: unknown }).render;
			else chat.container.render = chat.shadowed as ContainerLike["render"];
		}
		this.tui?.requestRender();
	}
}

/**
 * Run the new-session slot from the transcript's own render, whenever its children changed since
 * the last frame (DESIGN.md §10.3). pi adds a line and then asks for a frame, so the slot sees the
 * line before any frame shows it; a timer would always leave a gap. Unchanged frames cost one
 * comparison.
 */
function attachNewSession(
	container: ContainerLike,
	slot: SessionDividerSlot,
): NonNullable<Attachment["chat"]> {
	const shadowed = Object.hasOwn(container, "render") ? container.render : undefined;
	const original = container.render;
	let seen = -1;
	const render = (width: number): string[] => {
		if (container.children.length !== seen) {
			slot.update(container);
			seen = container.children.length;
		}
		return original.call(container, width);
	};
	container.render = render;
	return { container, render, shadowed };
}

function defaultHints(theme: Theme): string {
	return [
		keyHint("app.interrupt", "interrupt"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
		keyHint("app.tools.expand", "expand"),
	].join(theme.fg("muted", " · "));
}

/**
 * Breadth-first from the TUI root: the container holding `target`, and the two containers right
 * after it — pi's resource listing and its transcript (`chatContainer`).
 */
export function locate(
	root: unknown,
	target: unknown,
): { header: ContainerLike; resources: ContainerLike | undefined; chat: ContainerLike | undefined } | undefined {
	const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
	while (queue.length > 0) {
		const { node, depth } = queue.shift()!;
		if (!isContainer(node) || depth > 4) continue;
		const index = node.children.findIndex((child) => isContainer(child) && child.children.includes(target));
		if (index >= 0) {
			const next = node.children[index + 1];
			const chat = node.children[index + 2];
			return {
				header: node.children[index] as ContainerLike,
				resources: isContainer(next) ? next : undefined,
				chat: isContainer(chat) ? chat : undefined,
			};
		}
		for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
	}
	return undefined;
}

/** pi's collapsed sections are ThemedText with an expand state; `build` gives the unwrapped text. */
function readSection(child: unknown): ResourceSection | "expanded" | undefined {
	const candidate = child as { build?: unknown; state?: { expanded?: unknown } } | null;
	if (!candidate || typeof candidate.build !== "function" || typeof candidate.state?.expanded !== "boolean") {
		return undefined;
	}
	if (candidate.state.expanded) return "expanded";
	const text = (candidate.build as () => unknown).call(candidate);
	return typeof text === "string" ? parseSection(text) : undefined;
}

function isSpacer(value: unknown): value is SpacerLike {
	return typeof value === "object" && value !== null && typeof (value as SpacerLike).setLines === "function";
}

function isContainer(value: unknown): value is ContainerLike {
	return typeof value === "object" && value !== null && Array.isArray((value as ContainerLike).children);
}

function isComponent(value: unknown): value is Component {
	return typeof value === "object" && value !== null && typeof (value as Component).render === "function";
}

export function installHeader(
	ctx: ExtensionContext,
	config: BetterTuiConfig,
	getTheme: () => Theme,
	onTui: (tui: TUI) => void,
	newSession = false,
): () => void {
	// One slot for the session: pi may build the header more than once, the divider goes in once.
	const slot = newSession ? new SessionDividerSlot(new SessionDivider(getTheme)) : undefined;
	ctx.ui.setHeader((tui) => {
		onTui(tui);
		return new BetterHeader(config, getTheme, tui, defaultHints, slot);
	});
	return () => ctx.ui.setHeader(undefined);
}
