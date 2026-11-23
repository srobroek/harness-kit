import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * A pi extension that puts a plugin's rules into the system prompt, since pi has no rules resource. harness-kit copies
 * the plugin's rules to `rules/` in its pi tree and vendors this file as `_kit/rules.ts`. Before each prompt
 * (`before_agent_start`) it appends, in file-name order, every rule whose front matter says `alwaysApply: true` in full
 * under a heading that names it, then one line per other rule with its description and the absolute path to read it
 * from. The rules are read once, when pi loads the extension, so the appended text is the same on every turn.
 */

/** The slice of the pi extension API this file uses. */
interface Api {
	on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => { systemPrompt: string }): void
}

export interface Rule {
	/** Path under `rules/` without the extension, such as `testing` or `go/style`. */
	name: string
	/** Absolute path of the rule file. */
	file: string
	alwaysApply: boolean
	description?: string
	/** The text after the front matter, trimmed. */
	body: string
}

const RULE_FILE = /\.mdc?$/
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/
const FIELD = /^([A-Za-z_][\w-]*):[^\S\r\n]*(.*)$/

/** The top-level `key: value` pairs of a front-matter block, without surrounding quotes. Nested values are skipped. */
function fields(block: string): Record<string, string> {
	const found: Record<string, string> = {}
	for (const line of block.split(/\r?\n/)) {
		const match = FIELD.exec(line)
		if (!match) continue
		const value = (match[2] ?? "").trim()
		found[match[1] as string] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
	}
	return found
}

export function parseRule(name: string, file: string, text: string): Rule {
	const match = FRONT_MATTER.exec(text)
	const front = match ? fields(match[1] ?? "") : {}
	return {
		name,
		file,
		alwaysApply: front.alwaysApply === "true",
		...(front.description ? { description: front.description } : {}),
		body: (match ? text.slice(match[0].length) : text).trim(),
	}
}

/** Rule files under `dir` as posix paths relative to it, in code-unit order. */
function ruleFiles(dir: string, prefix = ""): string[] {
	const found: string[] = []
	for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) found.push(...ruleFiles(dir, relative))
		else if (RULE_FILE.test(entry.name)) found.push(relative)
	}
	return found
}

/** The rules under `dir`, ordered by file name; none when the directory is missing. */
export function loadRules(dir: string): Rule[] {
	if (!existsSync(dir)) return []
	return ruleFiles(dir)
		.sort()
		.map((relative) => parseRule(relative.replace(RULE_FILE, ""), join(dir, relative), readFileSync(join(dir, relative), "utf8")))
}

/** The text appended to the system prompt: always-on rules in full, then an index of the others. Empty without rules. */
export function renderRules(rules: readonly Rule[]): string {
	const sections = rules.filter((rule) => rule.alwaysApply).map((rule) => `## Rule: ${rule.name}\n\n${rule.body}`)
	const index = rules.filter((rule) => !rule.alwaysApply).map((rule) => `- ${rule.name}: ${rule.description ?? "no description"} (${rule.file})`)
	if (index.length > 0) sections.push(["## Rules to read on demand", "", "Read a rule's file before work that its description covers.", "", ...index].join("\n"))
	return sections.join("\n\n")
}

export interface Deps {
	/** The pi tree holding `rules/`; defaults to the parent of the `_kit` directory. */
	root?: string
}

export default function rulesExtension(pi: Api, deps: Deps = {}): void {
	const root = deps.root ?? join(dirname(fileURLToPath(import.meta.url)), "..")
	const text = renderRules(loadRules(join(root, "rules")))
	if (!text) return
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${text}` }))
}
