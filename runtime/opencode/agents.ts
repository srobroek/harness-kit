import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

/**
 * Agent registration for an OpenCode plugin that ships `agents/<id>.md`.
 *
 * Two installed plugins can ship the same agent (a repo-level `shared/` item copied into both). OpenCode would
 * register the id twice and the last plugin loaded would win, so a version skew between the copies would depend on
 * load order in the other direction. `registerAgents` skips an id that is already registered and logs one debug
 * line, so the first plugin loaded wins every time.
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

export interface RegisterOptions {
	/** Fill a new agent's draft from its file. Defaults to `description`, `mode` and `system`. */
	apply?: (draft: any, file: AgentFile) => void;
	/** Receives the line logged for a skipped agent. Defaults to `console.debug`. */
	debug?: (line: string) => void;
}

/** Registers the agents the host does not know yet. Returns the registration to dispose, and the ids it skipped. */
export async function registerAgents(agent: AgentHost, files: AgentFile[], options: RegisterOptions = {}) {
	const apply =
		options.apply ??
		((draft: any, file: AgentFile) => {
			const description = file.field("description");
			const mode = file.field("mode");
			if (description !== undefined) draft.description = description;
			if (mode !== undefined) draft.mode = mode;
			draft.system = file.system;
		});
	const debug = options.debug ?? ((line: string) => console.debug(line));
	const skipped: string[] = [];
	const registration = await agent.transform((editor) => {
		for (const file of files) {
			if (editor.get(file.id) !== undefined) {
				skipped.push(file.id);
				debug(`agent "${file.id}" is already registered by another plugin; skipping the copy in ${file.path}`);
				continue;
			}
			editor.update(file.id, (draft) => apply(draft, file));
		}
	});
	return { dispose: registration.dispose, skipped };
}
