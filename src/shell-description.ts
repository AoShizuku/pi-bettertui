import {
	createBashToolDefinition,
	createPowerShellToolDefinition,
	type ExtensionAPI,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

/**
 * Pi's shell tools only take `command`, so the transcript can show nothing but
 * the raw command. These overrides add an optional `description` the model
 * fills in, and delegate execution to Pi's own implementation unchanged.
 */
export const SHELL_DESCRIPTION_HINT =
	"Short description of what this command does (5-10 words), shown to the user in place of the command. Write it in the user's language; keep commands, paths, and identifiers verbatim.";

export type ShellToolName = "bash" | "powershell";

export const SHELL_TOOL_NAMES: readonly ShellToolName[] = ["bash", "powershell"];

// The override changes the parameter schema of a built-in definition.
type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Insert an optional `description` right after `command`, keeping every other parameter as is. */
export function withDescriptionParameter(parameters: TSchema): TSchema {
	const source = parameters as { properties?: Record<string, TSchema>; additionalProperties?: unknown };
	const description = Type.Optional(Type.String({ description: SHELL_DESCRIPTION_HINT }));
	const properties: Record<string, TSchema> = {};
	for (const [key, value] of Object.entries(source.properties ?? {})) {
		if (key === "description") continue;
		properties[key] = value;
		if (key === "command") properties.description = description;
	}
	properties.description ??= description;
	const options = typeof source.additionalProperties === "boolean"
		? { additionalProperties: source.additionalProperties }
		: {};
	return Type.Object(properties, options);
}

function nativeDefinition(name: ShellToolName, cwd: string, settings?: SettingsManager): AnyToolDefinition {
	if (name === "powershell") return createPowerShellToolDefinition(cwd) as AnyToolDefinition;
	// Same options Pi passes when it builds its own bash tool.
	const options = settings
		? { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() }
		: undefined;
	return createBashToolDefinition(cwd, options) as AnyToolDefinition;
}

function shellSettings(getSettings: () => Settings): SettingsManager | undefined {
	try {
		return SettingsManager.inMemory(getSettings());
	} catch {
		return undefined;
	}
}

export function createDescribedShellTool(name: ShellToolName, getSettings: () => Settings): AnyToolDefinition {
	const template = nativeDefinition(name, process.cwd());
	return {
		...template,
		parameters: withDescriptionParameter(template.parameters),
		// Registration would activate the tool; leave activation to Pi's built-in rules
		// (bash on by default, powershell only when the user enables it).
		defaultActive: false,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { description: _description, ...rest } = (params ?? {}) as Record<string, unknown>;
			const native = nativeDefinition(name, ctx?.cwd || process.cwd(), shellSettings(getSettings));
			return native.execute(toolCallId, rest, signal, onUpdate, ctx);
		},
	};
}
