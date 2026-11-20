import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

/**
 * Agent registration for an OpenCode plugin that ships `agents/<id>.md`.
 *
 * Two installed plugins can ship the same agent (a repo-level `shared/` item copied into both). OpenCode would
 * register the id twice and the last plugin loaded would win. `registerAgents` has two modes.
 *
 * Default (first loaded wins): it skips an id that is already registered and logs one debug line.
 *
 * Owner-wins: one plugin owns the agent and the other ships a fallback copy, so work routed to the id never stalls
 * when the owner is not installed. Load order is not under either plugin's control, so both sides cooperate and
 * either order leaves one agent with the owner's fields:
 * - the fallback side passes `owners` (agent id to owner plugin name) and `plugin`. It skips a copy when
 *   `plugin.list` reports the owner installed, or when the id already exists;
 * - the owner side passes `role: "owner"`. It replaces an existing copy whose prompt equals its own with a fresh
 *   registration (permissions and model dropped, and the `fallbackHeader` request header if set), and otherwise
 *   layers over the existing agent without overwriting its fields (`apply` gets `created = false`).
 */

export interface AgentFile {
	/** The file name without `.md`. */
	id: string;
	path: string;
	/** A `key: value` line of the front matter. */
	field(key: string): string | undefined;
	/** The prompt: the text after the front matter, trimmed. */
	system: string;
}

/** The agent files under `root/agents/*.md`, in name order. */
export function loadAgentFiles(root: string): AgentFile[] {
	const dir = join(root, "agents");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => {
			const path = join(dir, file);
			const frontmatter = parseFrontmatter(readFileSync(path, "utf8"));
			const text = frontmatter ? frontmatter.body : readFileSync(path, "utf8");
			return { id: basename(file, ".md"), path, field: (key: string) => frontmatter?.field(key), system: text.trim() };
		});
}

/** The slice of `ctx.agent` this module uses. */
interface AgentHost {
	transform(change: (editor: { get(id: string): unknown; update(id: string, change: (draft: any) => void): void }) => void): Promise<{ dispose: () => Promise<void> }>;
}

/** How a `plugin.list` entry is matched to an owner plugin name. Both default to "no prefix". */
export interface PluginMatch {
	/** The entry's `id` is `idPrefix + name` (for example `acme.`). Default: the id equals the name. */
	idPrefix?: string;
	/** A package target or local path names the plugin as `name`, or `prefix + name` for each prefix (for example `opencode-`). */
	packagePrefixes?: string[];
}

/** The `plugin` slice of the host context this module uses. */
export interface PluginHost {
	list(): Promise<unknown>;
}

/** A debug sink: a function, or a host logger with a `debug` method. */
export type DebugSink = ((line: string) => void) | { debug(line: string): void };

export interface RegisterOptions {
	/**
	 * Fill a draft from its file. `created` is true for a new agent or a replaced copy, false when layering over an
	 * existing agent (owner side). Defaults to `description`, `mode` and `system`; with `created = false` the defaults
	 * only fill fields the agent lacks.
	 */
	apply?: (draft: any, file: AgentFile, created: boolean) => void;
	/** Receives the line logged for a skipped agent. A function or a host logger. Defaults to `console.debug`. */
	debug?: DebugSink;
	/** `"owner"` replaces fallback copies; `"fallback"` (default) never overwrites an existing agent. */
	role?: "owner" | "fallback";
	/** Fallback side: agent id to the name of the plugin that owns it. Ids not listed register as in the default mode. */
	owners?: Readonly<Record<string, string>>;
	/** Fallback side: the host's `ctx.plugin`. Without it, or when it fails, no owner counts as installed. */
	plugin?: PluginHost;
	/** Fallback side: how owner names match `plugin.list` entries. */
	pluginMatch?: PluginMatch;
	/** Fallback side: how long `plugin.list` may take before the owner counts as not installed. Default 2000. */
	listTimeoutMs?: number;
	/** Owner side: a request header dropped from a replaced copy, such as a model-fallback marker. Default: none. */
	fallbackHeader?: string;
}

/** `plugin.list` during setup must not hold up startup; a slow answer counts as "not installed". */
export const PLUGIN_LIST_TIMEOUT_MS = 2000;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `plugin.list` result, or undefined when it fails or takes longer than `ms`. */
export async function listPlugins(plugin: PluginHost, ms = PLUGIN_LIST_TIMEOUT_MS): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	try {
		return await Promise.race([plugin.list(), timeout]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Whether a `plugin.list` result (a `{ data }` envelope or an array) includes plugin `name`, by id, package target or local path. */
export function listsPlugin(listed: unknown, name: string, match: PluginMatch = {}): boolean {
	const entries = Array.isArray(listed) ? listed : (listed as { data?: unknown } | undefined)?.data;
	if (!Array.isArray(entries)) return false;
	const prefixes = (match.packagePrefixes ?? []).map(escapeRegExp).join("|");
	const target = new RegExp(`(^|[/:@])${prefixes ? `(?:${prefixes})?` : ""}${escapeRegExp(name)}(?=$|[@/#:.])`);
	const names = (value: unknown) => typeof value === "string" && target.test(value);
	return (entries as { id?: unknown; source?: { target?: unknown; path?: unknown } }[]).some(
		(entry) => entry?.id === `${match.idPrefix ?? ""}${name}` || names(entry?.source?.target) || names(entry?.source?.path),
	);
}

const defaultApply = (draft: any, file: AgentFile, created: boolean) => {
	const description = file.field("description");
	const mode = file.field("mode");
	if (description !== undefined && (created || draft.description === undefined)) draft.description = description;
	if (mode !== undefined && (created || draft.mode === undefined)) draft.mode = mode;
	if (created || draft.system === undefined) draft.system = file.system;
};

/** Owner side: the draft of a fallback copy, reset so the result matches a fresh registration. */
function resetCopy(draft: any, fallbackHeader: string | undefined) {
	if (draft.permissions !== undefined) draft.permissions = [];
	delete draft.model;
	if (fallbackHeader !== undefined && draft.request?.headers?.[fallbackHeader] !== undefined) {
		const { [fallbackHeader]: _dropped, ...headers } = draft.request.headers;
		draft.request = { ...draft.request, headers };
	}
}

/**
 * Registers the agents of `files`. Returns the registration to dispose, the ids it skipped, and (owner side) the
 * ids whose fallback copy it replaced.
 */
export async function registerAgents(agent: AgentHost, files: AgentFile[], options: RegisterOptions = {}) {
	const apply = options.apply ?? defaultApply;
	const sink = options.debug ?? ((line: string) => console.debug(line));
	const debug = typeof sink === "function" ? sink : (line: string) => sink.debug(line);
	const owner = options.role === "owner";
	const owners = options.owners ?? {};
	const skipped: string[] = [];
	const replaced: string[] = [];
	const installed = new Set<string>();
	if (!owner && options.plugin && files.some((file) => file.id in owners)) {
		const listed = await listPlugins(options.plugin, options.listTimeoutMs);
		for (const [id, name] of Object.entries(owners)) if (listsPlugin(listed, name, options.pluginMatch)) installed.add(id);
	}
	const registration = await agent.transform((editor) => {
		for (const file of files) {
			const existing = editor.get(file.id) as { system?: unknown } | undefined;
			if (owner) {
				const copy = existing !== undefined && existing.system === file.system;
				if (copy) replaced.push(file.id);
				editor.update(file.id, (draft) => {
					if (copy) resetCopy(draft, options.fallbackHeader);
					apply(draft, file, existing === undefined || copy);
				});
				continue;
			}
			if (installed.has(file.id)) {
				skipped.push(file.id);
				debug(`agent "${file.id}" is owned by plugin "${owners[file.id]}", which is installed; skipping the copy in ${file.path}`);
				continue;
			}
			if (existing !== undefined) {
				skipped.push(file.id);
				debug(`agent "${file.id}" is already registered by another plugin; skipping the copy in ${file.path}`);
				continue;
			}
			editor.update(file.id, (draft) => apply(draft, file, true));
		}
	});
	return { dispose: registration.dispose, skipped, replaced };
}
