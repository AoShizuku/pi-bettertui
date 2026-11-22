import { type Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { splitUserImages, UserImageLines } from "./user-images.js";

/**
 * Left gutter shared with pi-editor and pi-hud (pi-shizuku README.md, DESIGN.md §1):
 * markers in column 0, content from column 2.
 */
export const GUTTER = 2;

const USER_PATCH_KEY = Symbol.for("pi-bettertui.user-gutter");

/** Leading SGR sequences, then the first padding space that the marker replaces. */
// eslint-disable-next-line no-control-regex
const LEADING_SPACE = /^((?:\x1b\[[0-9;:]*m)*) /;

/**
 * Put `marker` in column 0 of a line that starts with plain padding. Styles opened before the
 * padding (a message background) stay in front, so the background runs on under the marker.
 */
export function placeMarker(line: string, marker: string): string {
	const match = LEADING_SPACE.exec(line);
	if (!match) return line;
	const prefix = match[1] ?? "";
	return prefix + marker + line.slice(prefix.length + 1);
}

/** Wraps a block and puts a marker in column 0 of one of its lines. */
export class MarkedBlock implements Component {
	constructor(
		readonly block: Component,
		private readonly line: number,
		private readonly marker: () => string,
	) {}

	render(width: number): string[] {
		const lines = this.block.render(width);
		if (lines.length <= this.line) return lines;
		// Markdown hands out its cached array; never write into it.
		const out = [...lines];
		out[this.line] = placeMarker(out[this.line]!, this.marker());
		return out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.block.handleMouse?.(event);
	}

	invalidate(): void {
		this.block.invalidate();
	}
}

/** Markdown and Text keep their horizontal padding in `paddingX`; both rebuild on invalidate(). */
function setPadding(target: unknown, padding: number): void {
	const value = target as { paddingX?: unknown; invalidate?: () => void } | undefined;
	if (!value || typeof value.paddingX !== "number" || value.paddingX === padding) return;
	value.paddingX = padding;
	value.invalidate?.();
}

function outputPadOf(component: { outputPad?: unknown }): number {
	return typeof component.outputPad === "number" ? component.outputPad : 1;
}

// ---------------------------------------------------------------------------
// Assistant messages (called from the updateContent patch in thinking.ts)
// ---------------------------------------------------------------------------

/** The text Markdown blocks of an assistant message's last update; pi records each in `markdownSlots`. */
export function assistantTextBlocks(component: any): Set<unknown> {
	const blocks = new Set<unknown>();
	const slots: unknown[] = Array.isArray(component?.markdownSlots) ? component.markdownSlots : [];
	for (const slot of slots) {
		const value = slot as { kind?: unknown; markdown?: unknown };
		if (value?.kind === "text" && value.markdown) blocks.add(value.markdown);
	}
	return blocks;
}

/**
 * Move an assistant message's text into the content column and mark each text block with a muted `●`,
 * lighter than a tool row's so the two don't compete for column 0 (DESIGN.md §3).
 * pi reuses the text Markdown across streaming updates, so disabling must put its padding back.
 */
export function applyAssistantGutter(component: any, enabled: boolean, getTheme: () => Theme): void {
	const container = component?.contentContainer;
	if (!container || !Array.isArray(container.children)) return;
	const textBlocks = assistantTextBlocks(component);
	const padding = enabled ? GUTTER : outputPadOf(component);

	const children = container.children as unknown[];
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		// Thinking runs are click regions (handled by the thinking view); spacers have no padding.
		if (textBlocks.has(child)) {
			setPadding(child, padding);
			if (enabled) children[index] = new MarkedBlock(child as Component, 0, () => getTheme().fg("muted", "●"));
		} else if (enabled) {
			// Truncation, abort and error notes: plain Text built fresh on every update.
			setPadding(child, GUTTER);
		}
	}
}

// ---------------------------------------------------------------------------
// User messages
// ---------------------------------------------------------------------------

export interface UserGutterHooks {
	isEnabled: () => boolean;
	getTheme: () => Theme;
}

interface UserPatchRecord {
	owner: object;
	hooks: UserGutterHooks;
	original: (...args: any[]) => any;
	patched: (...args: any[]) => any;
}

const userCleanups = new Set<() => void>();
/** Identifies patches made by this module instance; each /reload loads a new one. */
const MODULE_OWNER = {};

export function installUserMessagePatch(hooks: UserGutterHooks): void {
	patchUserPrototype(UserMessageComponent.prototype as any, hooks);
}

export function uninstallUserMessagePatches(): void {
	for (const cleanup of [...userCleanups]) cleanup();
	userCleanups.clear();
}

/**
 * pi may build user messages from a different module instance than the one imported here
 * (see the thinking patch): patch the prototypes of the messages already on screen and rebuild them.
 */
export function refreshLiveUserMessages(tui: unknown, hooks: UserGutterHooks): number {
	const components = collect(tui, isUserMessage);
	const prototypes = new Set<object>();
	for (const component of components) {
		const proto = Object.getPrototypeOf(component);
		if (proto && typeof proto === "object") prototypes.add(proto);
	}
	for (const proto of prototypes) patchUserPrototype(proto as any, hooks);
	for (const component of components) component.rebuild();
	return components.length;
}

function patchUserPrototype(proto: any, hooks: UserGutterHooks): void {
	const existing = proto[USER_PATCH_KEY] as UserPatchRecord | undefined;
	if (existing?.owner === MODULE_OWNER) {
		existing.hooks = hooks;
		return;
	}
	// A patch from an earlier load of this extension (/reload) would keep running its old code.
	if (existing) {
		if (proto.rebuild === existing.patched) proto.rebuild = existing.original;
		proto[USER_PATCH_KEY] = undefined;
	}
	const original = proto.rebuild;
	if (typeof original !== "function") return;

	const record: UserPatchRecord = {
		owner: MODULE_OWNER,
		hooks,
		original,
		patched: function (this: any, ...args: any[]): any {
			const result = original.apply(this, args);
			decorateUserMessage(this, record.hooks);
			return result;
		},
	};
	proto[USER_PATCH_KEY] = record;
	proto.rebuild = record.patched;

	userCleanups.add(() => {
		if (proto[USER_PATCH_KEY] !== record) return;
		if (proto.rebuild === record.patched) proto.rebuild = original;
		proto[USER_PATCH_KEY] = undefined;
	});
}

/** rebuild() starts from a fresh Markdown, so only the enabled case needs work. */
function decorateUserMessage(component: any, hooks: UserGutterHooks): void {
	if (!hooks.isEnabled() || !Array.isArray(component.children)) return;
	const markdown = component.children[0];
	if (!markdown || typeof markdown.paddingX !== "number") return;
	setPadding(markdown, GUTTER);
	// Drop the blank background rows above and below the text: the band hugs the message.
	if (typeof markdown.paddingY === "number" && markdown.paddingY !== 0) {
		markdown.paddingY = 0;
		markdown.invalidate?.();
	}
	// Image references and pi's image notes leave the band; each image gets a rail line under it (§4.1).
	const split = typeof component.text === "string" ? splitUserImages(component.text) : undefined;
	if (split && typeof markdown.setText === "function") markdown.setText(split.body);
	component.children[0] = new MarkedBlock(markdown, 0, () => hooks.getTheme().fg("muted", "❯"));
	if (split && typeof markdown.setText === "function") component.children.push(new UserImageLines(split.images, hooks.getTheme));
}

export function isUserMessage(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as any;
	return (
		typeof candidate.rebuild === "function" &&
		typeof candidate.setOutputPad === "function" &&
		typeof candidate.text === "string" &&
		candidate.markdownTheme !== undefined &&
		// Custom and skill messages also rebuild; they carry their message object instead of plain text.
		!("message" in candidate) &&
		!("skillBlock" in candidate) &&
		!("lastMessage" in candidate)
	);
}

function collect(root: unknown, match: (value: unknown) => boolean): any[] {
	const out: any[] = [];
	const stack: unknown[] = [root];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const value = stack.pop();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		const candidate = value as any;
		if (match(candidate)) {
			out.push(candidate);
			continue;
		}
		if (Array.isArray(candidate.children)) {
			for (const child of candidate.children) stack.push(child);
		}
		if (candidate.child) stack.push(candidate.child);
	}
	return out;
}
