import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.ts";

/**
 * Content runtime of an OpenCode plugin. The plugin ships markdown and nothing else:
 *  - `rules/*.md` and `templates/*.md` go into the `system` prompt of every model request (`ctx.session.hook("context")`).
 *    A template may hold `${user_config.<name>}` placeholders. Each takes the plugin entry's option of that name, else the
 *    default in `options.json` (generated from the `options` of the plugin's package.json).
 *  - `skills/<name>/SKILL.md` register through `ctx.skill.transform`, unless the user already has a skill of that name.
 *
 * The system part is a standalone part. agent-efficiency's lean trimming (`leanSystem`) removes the `Instructions from:`
 * sections of AGENTS.md files, the model identity and the worktree hint, and nothing else, so these rules reach every
 * subagent, including the read-only ones that the trimming otherwise slims down.
 *
 * This file holds no import of `@opencode/plugin`, so tests load it without the host package; the plugin's `main.ts` wraps it.
 */

export interface SkillDefinition {
	id: string;
	name: string;
	description: string;
	path: string;
	content: string;
}

/** The slice of the host context this runtime uses. */
type Context = any;

const PLACEHOLDER = /\$\{user_config\.([a-z][a-z0-9_]*)\}/g;

/** The defaults of `options.json` with the plugin entry's options on top. Throws on an unknown name or a non-string value. */
export function resolveOptions(root: string, given: unknown): Record<string, string> {
	const file = join(root, "options.json");
	const defaults: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	const values = { ...defaults };
	if (given === undefined || given === null) return values;
	if (typeof given !== "object" || Array.isArray(given)) throw new Error("plugin options must be an object");
	for (const [name, value] of Object.entries(given)) {
		if (!(name in defaults)) throw new Error(`unknown option "${name}" (known: ${Object.keys(defaults).join(", ") || "none"})`);
		if (typeof value !== "string") throw new Error(`option "${name}" must be a string`);
		values[name] = value;
	}
	return values;
}

/** Fill the `${user_config.<name>}` placeholders of a template. A placeholder without a value stays as written. */
export function renderTemplate(text: string, values: Record<string, string>): string {
	return text.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

function markdownIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => join(dir, file));
}

/** The text of every `rules/*.md` file under `root`, trimmed, in name order, joined by blank lines. Empty when there is none. */
export function loadRules(root: string): string {
	return markdownIn(join(root, "rules"))
		.map((file) => readFileSync(file, "utf8").trim())
		.join("\n\n");
}

/** The text pushed into the system prompt: every rule, then every rendered template, each trimmed, joined by blank lines. */
export function loadPrompt(root: string, options: Record<string, string>): string {
	const rules = markdownIn(join(root, "rules")).map((file) => readFileSync(file, "utf8").trim());
	const templates = markdownIn(join(root, "templates")).map((file) => renderTemplate(readFileSync(file, "utf8"), options).trim());
	return [...rules, ...templates].join("\n\n");
}

/** The skills under `root/skills/<name>/SKILL.md`. A skill whose front matter lacks a name or description is skipped. */
export function loadSkills(root: string): SkillDefinition[] {
	const dir = join(root, "skills");
	if (!existsSync(dir)) return [];
	const found: SkillDefinition[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(dir, entry.name, "SKILL.md");
		if (!existsSync(path)) continue;
		const frontmatter = parseFrontmatter(readFileSync(path, "utf8"));
		const name = frontmatter?.field("name");
		const description = frontmatter?.field("description");
		if (!frontmatter || !name || !description) continue;
		found.push({ id: name, name, description, path, content: frontmatter.body.trim() });
	}
	return found;
}

export interface SetupOptions {
	/** Install tree holding `rules/`, `templates/`, `skills/` and `options.json`; defaults to the parent of the `_kit` directory. */
	root?: string;
	/** Raw plugin options; defaults to the plugin entry's `options`. */
	options?: unknown;
}

export async function setupContent(ctx: Context, setup: SetupOptions = {}) {
	const root = setup.root ?? join(dirname(fileURLToPath(import.meta.url)), "..");
	const options = resolveOptions(root, setup.options ?? ctx.options);
	const registrations: Array<{ dispose: () => Promise<void> }> = [];
	const skills = loadSkills(root);
	if (skills.length > 0 && ctx.skill?.transform) {
		registrations.push(
			await ctx.skill.transform((editor: any) => {
				for (const skill of skills) if (editor.get?.(skill.id) === undefined) editor.add(skill);
			}),
		);
	}
	const prompt = loadPrompt(root, options);
	if (prompt !== "" && ctx.session?.hook) {
		registrations.push(await ctx.session.hook("context", (event: { system: Array<{ type: string; text: string }> }) => void event.system.push({ type: "text", text: prompt })));
	}
	return async () => {
		for (const registration of registrations.reverse()) await registration.dispose();
	};
}
