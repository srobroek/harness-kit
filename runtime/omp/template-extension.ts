import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * An OMP extension that appends a rendered template to the system prompt. OMP has no per-extension options, and a
 * marketplace install copies the tree into OMP's cache, so the options live in `<name>.json` in the OMP agent directory
 * (`$PI_CODING_AGENT_DIR`, default `~/.omp/agent`): a JSON object of strings with the names in `options.json`. A missing
 * file means the defaults. A file that cannot be parsed, or that holds an unknown name or a non-string, is reported once
 * and the defaults apply.
 *
 * `templateExtension("secrets")` renders `templates/secrets.md` and appends it before each prompt (`before_agent_start`).
 */

const PLACEHOLDER = /\$\{user_config\.([a-z][a-z0-9_]*)\}/g

/** The slice of the OMP extension API this file uses. */
interface Api {
	on(event: "before_agent_start", handler: (event: { systemPrompt: string[] }) => { systemPrompt: string[] }): void
}

export function agentDir(env: Record<string, string | undefined> = process.env): string {
	const custom = env.PI_CODING_AGENT_DIR?.trim()
	return custom ? custom : join(homedir(), ".omp", "agent")
}

/** The defaults with the user's file on top. Throws on an unknown name or a non-string value. */
export function resolveOptions(defaults: Record<string, string>, given: unknown, fileName = "options file"): Record<string, string> {
	const values = { ...defaults }
	if (given === undefined) return values
	if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error(`${fileName} must be an object`)
	for (const [name, value] of Object.entries(given)) {
		if (!(name in defaults)) throw new Error(`unknown option "${name}"`)
		if (typeof value !== "string") throw new Error(`option "${name}" must be a string`)
		values[name] = value
	}
	return values
}

export function render(template: string, values: Record<string, string>): string {
	return template.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole)
}

export interface Deps {
	/** Install tree holding `templates/` and `options.json`; defaults to the parent of the `_kit` directory. */
	root?: string
	/** Path of the user's options file; defaults to `<name>.json` in the agent directory. */
	optionsPath?: string
	warn?: (message: string) => void
}

export function templateExtension(name: string) {
	return function extension(pi: Api, deps: Deps = {}): void {
		const root = deps.root ?? join(dirname(fileURLToPath(import.meta.url)), "..")
		const warn = deps.warn ?? ((message: string) => console.error(`${name}: ${message}`))
		const defaults = JSON.parse(readFileSync(join(root, "options.json"), "utf8")) as Record<string, string>
		const path = deps.optionsPath ?? join(agentDir(), `${name}.json`)
		let values = defaults
		if (existsSync(path)) {
			try {
				values = resolveOptions(defaults, JSON.parse(readFileSync(path, "utf8")), `${name}.json`)
			} catch (error) {
				warn(`${path}: ${error instanceof Error ? error.message : String(error)}; using the defaults`)
			}
		}
		const text = render(readFileSync(join(root, "templates", `${name}.md`), "utf8"), values).trim()
		pi.on("before_agent_start", (event) => ({ systemPrompt: [...event.systemPrompt, text] }))
	}
}
