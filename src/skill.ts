import { SkillInvocationMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";

/**
 * A `/skill:name` invocation is drawn by pi's skill message component: a full-width
 * colored box with a blank line above and below. This patch redraws it as a compact
 * row that lines up with the tool rows:
 *
 *   ● [Skill] (code-review) ▸
 *
 * The component is a Box; the patch clears its background and padding (the marker is the
 * gutter's column 0, see DESIGN.md §2) and replaces the children, so pi's expand toggle still applies.
 */

const PATCH_KEY = Symbol.for("pi-bettertui.skill");

export interface SkillPatchHooks {
	isEnabled: () => boolean;
	getTheme: () => Theme;
}

interface PatchRecord {
	hooks: SkillPatchHooks;
	original: (...args: any[]) => any;
	patched: (...args: any[]) => any;
}

interface BoxLook {
	bgFn: unknown;
	paddingX: unknown;
	paddingY: unknown;
}

/** The box look pi gave each component, so turning the plugin off restores it. */
const nativeLook = new WeakMap<object, BoxLook>();
/** Undo functions of every prototype patched by this module instance. */
const cleanups = new Set<() => void>();

/** `● [Skill]` in the skill color, the name in parentheses like a tool row's detail. */
export function skillHeader(theme: Theme, name: string, expanded: boolean): string {
	const label = theme.fg("customMessageLabel", `● ${theme.bold("[Skill]")}`);
	const detail = name ? ` ${theme.fg("muted", `(${name})`)}` : "";
	return `${label}${detail} ${theme.fg("dim", expanded ? "▾" : "▸")}`;
}

export function installSkillPatch(hooks: SkillPatchHooks): void {
	patchPrototype(SkillInvocationMessageComponent.prototype as any, hooks);
}

/** Restore pi's own updateDisplay on every patched prototype (extension shutdown or reload). */
export function uninstallSkillPatches(): void {
	for (const cleanup of [...cleanups]) cleanup();
	cleanups.clear();
}

/**
 * Pi may render through a different module instance than the one this extension
 * imports (see the thinking patch), so also patch the prototype of every skill
 * message already on screen and rebuild those components. Returns how many it found.
 */
export function refreshLiveSkills(tui: unknown, hooks: SkillPatchHooks): number {
	const components = collectSkillComponents(tui);
	const prototypes = new Set<object>();
	for (const component of components) {
		const proto = Object.getPrototypeOf(component);
		if (proto && typeof proto === "object") prototypes.add(proto);
	}
	for (const proto of prototypes) patchPrototype(proto as any, hooks);
	for (const component of components) component.updateDisplay();
	return components.length;
}

function patchPrototype(proto: any, hooks: SkillPatchHooks): void {
	const existing = proto[PATCH_KEY] as PatchRecord | undefined;
	if (existing) {
		existing.hooks = hooks;
		return;
	}
	const original = proto.updateDisplay;
	if (typeof original !== "function") return;

	const record: PatchRecord = {
		hooks,
		original,
		patched: function (this: any, ...args: any[]): any {
			if (!nativeLook.has(this)) nativeLook.set(this, { bgFn: this.bgFn, paddingX: this.paddingX, paddingY: this.paddingY });
			if (!record.hooks.isEnabled() || !isSkillComponent(this)) {
				restoreLook(this);
				return original.apply(this, args);
			}
			renderCompact(this, record.hooks.getTheme());
			return undefined;
		},
	};
	proto[PATCH_KEY] = record;
	proto.updateDisplay = record.patched;

	cleanups.add(() => {
		const current = proto[PATCH_KEY] as PatchRecord | undefined;
		if (current !== record) return;
		if (proto.updateDisplay === record.patched) proto.updateDisplay = original;
		proto[PATCH_KEY] = undefined;
	});
}

function restoreLook(component: any): void {
	const look = nativeLook.get(component);
	if (!look) return;
	if (typeof component.setBgFn === "function") component.setBgFn(look.bgFn);
	component.paddingX = look.paddingX;
	component.paddingY = look.paddingY;
}

function renderCompact(component: any, theme: Theme): void {
	if (typeof component.setBgFn === "function") component.setBgFn(undefined);
	component.paddingX = 0;
	component.paddingY = 0;
	component.clear();

	const block = component.skillBlock as { name?: unknown; content?: unknown };
	const name = typeof block.name === "string" ? block.name : "";
	const expanded = component.expanded === true;
	const content = new Container();
	content.addChild(new Text(skillHeader(theme, name, expanded), 0, 0));
	if (expanded) {
		const body = typeof block.content === "string" ? block.content : "";
		content.addChild(
			new Markdown(body, 2, 0, component.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
	component.addChild(
		new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			component.setExpanded(!component.expanded);
			return { handled: true };
		}),
	);
}

function isSkillComponent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as any;
	return (
		typeof candidate.updateDisplay === "function" &&
		typeof candidate.setExpanded === "function" &&
		typeof candidate.clear === "function" &&
		typeof candidate.addChild === "function" &&
		candidate.markdownTheme !== undefined &&
		typeof candidate.skillBlock === "object" &&
		candidate.skillBlock !== null &&
		typeof candidate.skillBlock.name === "string"
	);
}

function collectSkillComponents(root: unknown): any[] {
	const out: any[] = [];
	const stack: unknown[] = [root];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const value = stack.pop();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		const candidate = value as any;
		if (isSkillComponent(candidate)) {
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
