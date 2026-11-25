import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * A pi extension that puts a plugin's rules into the system prompt and enforces their triggers, since pi has no rules
 * resource. harness-kit copies the plugin's rules to `rules/` in its pi tree and vendors this file as `_kit/rules.ts`.
 *
 * Before each prompt (`before_agent_start`) it sets one system prompt section, named after the package (`sectionName`),
 * to every rule whose front matter says `alwaysApply: true` in full under a heading that names it, then one line per
 * other rule with its `globs`, its description and the absolute path to read it from, in file-name order. The rules are
 * read once, when pi loads the extension, so the section is the same on every run and pi sends no patch for it.
 *
 * A rule with `globs` and no trigger is delivered once per session, appended to the result of the first `read`, `edit`
 * or `write` call whose path matches one of them. It never enters the system prompt.
 *
 * A rule with OMP's trigger front matter (`condition`, `scope`, `interruptMode`) also fires, at most once per session:
 * - Tool scopes (`tool:bash`, `tool:edit`, `tool:write`, `tool:read`, each optionally `(<glob>)`; `tool` for all four):
 *   a call whose command, new text, content or path matches a condition, and whose path matches the glob, is blocked
 *   with the rule as the reason when the rule interrupts (`always`, the default as in OMP, or `tool-only`). The model
 *   can retry it. Otherwise the rule is appended to that call's result.
 * - `text` and `thinking`: a streamed reply or reasoning that matches gets the rule as a steering message. pi delivers a
 *   steer after the current turn's tool calls; aborting would return the queued message to the editor instead of
 *   starting a turn, so an interrupting rule steers without aborting.
 * No `scope` means `text` and every tool. Tools pi lacks (`tool:eval`) are skipped. As in OMP, `globs` on a triggered
 * rule gate every match on the call's path, so such a rule fires on path-bearing tool calls only. A rule with no usable
 * scope, only the never-matching `(?!)`, or an invalid condition or glob (reported once) is in the index only.
 *
 * Loading the extension twice in one session, from two copies of the package, is safe: the first copy to see the session
 * owns it, and the others do nothing in it.
 */

type Interrupt = "always" | "never" | "prose-only" | "tool-only"
type ToolName = "bash" | "edit" | "write" | "read"
type Source = "text" | "thinking"

const TOOLS: readonly ToolName[] = ["bash", "edit", "write", "read"]
/** The tools whose `path` names one file. */
const FILE_TOOLS: readonly string[] = ["edit", "write", "read"]

export interface ToolScope {
	tool: ToolName
	/** Gate on the call's `path`, tested as given, absolute, relative to the cwd, and as a base name. */
	glob?: RegExp
}

export interface Trigger {
	conditions: RegExp[]
	tools: ToolScope[]
	text: boolean
	thinking: boolean
	interrupt: Interrupt
	/** The rule's `globs`: a call must also have a path that one of them matches. */
	paths?: RegExp[]
}

export interface Rule {
	/** Path under `rules/` without the extension, such as `testing` or `go/style`. */
	name: string
	/** Absolute path of the rule file. */
	file: string
	alwaysApply: boolean
	description?: string
	/** The `globs` front matter as written, one entry per glob. */
	globs?: string[]
	/** `globs` as anchored regexes, in the same order. */
	paths?: RegExp[]
	/** The text after the front matter, trimmed. */
	body: string
	trigger?: Trigger
	/** Why the rule's trigger or globs are not enforced, when its front matter cannot be used. */
	problem?: string
}

/** The slice of pi's extension context this file uses. */
interface Context {
	cwd: string
	sessionManager: { getSessionId(): string }
}

interface ToolCallEvent {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
}

interface ToolResultEvent {
	toolCallId: string
	content: unknown[]
	structuredContent?: unknown
}

interface MessageUpdateEvent {
	assistantMessageEvent?: { type: string; contentIndex?: number; delta?: string; content?: string }
}

interface CustomMessage {
	customType: string
	content: string
	display: boolean
}

/** The slice of the pi extension API this file uses. */
interface Api {
	on(event: "before_agent_start", handler: (event: { systemPromptOptions: { sections: Record<string, string> } }, ctx: Context) => void): void
	on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: Context) => void): void
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: Context) => { block: true; reason: string } | undefined): void
	on(event: "tool_result", handler: (event: ToolResultEvent, ctx: Context) => { content: unknown[]; structuredContent?: unknown } | undefined): void
	on(event: "message_start", handler: (event: { message?: { role?: string } }, ctx: Context) => void): void
	on(event: "message_update", handler: (event: MessageUpdateEvent, ctx: Context) => void): void
	sendMessage(message: CustomMessage, options: { deliverAs: "steer" }): void
}

const RULE_FILE = /\.mdc?$/
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/
const FIELD = /^([A-Za-z_][\w-]*):[^\S\r\n]*(.*)$/
const LIST_ITEM = /^\s*-\s+(.*)$/
const NEVER = "(?!)"
const LEADING_FLAGS = /^\(\?([ims]+)\)/

const ESCAPES: Readonly<Record<string, string>> = {
	"0": "\0",
	a: "\x07",
	b: "\b",
	t: "\t",
	"\t": "\t",
	n: "\n",
	v: "\v",
	f: "\f",
	r: "\r",
	e: "\x1b",
	" ": " ",
	'"': '"',
	"/": "/",
	"\\": "\\",
	N: "\x85",
	_: "\xa0",
	L: "\u2028",
	P: "\u2029",
}
const HEX_ESCAPES: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The YAML scalar that starts at `text[start]`, and the index just past it. A plain scalar ends at a `stop` character. */
function scalarAt(text: string, start: number, stop: string): [string, number] {
	const quote = text[start]
	if (quote === '"') {
		let out = ""
		for (let i = start + 1; i < text.length; i++) {
			const ch = text[i] as string
			if (ch === '"') return [out, i + 1]
			if (ch !== "\\") {
				out += ch
				continue
			}
			const next = text[++i] ?? ""
			const width = HEX_ESCAPES[next]
			if (width !== undefined) {
				const hex = text.slice(i + 1, i + 1 + width)
				if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new Error(`bad escape \\${next}${hex}`)
				out += String.fromCodePoint(Number.parseInt(hex, 16))
				i += width
			} else if (next in ESCAPES) out += ESCAPES[next]
			else throw new Error(`unknown escape \\${next}`)
		}
		throw new Error("unterminated double-quoted string")
	}
	if (quote === "'") {
		let out = ""
		for (let i = start + 1; i < text.length; i++) {
			if (text[i] !== "'") out += text[i]
			else if (text[i + 1] === "'") out += text[++i]
			else return [out, i + 1]
		}
		throw new Error("unterminated single-quoted string")
	}
	let end = start
	while (end < text.length && !stop.includes(text[end] as string)) end++
	return [text.slice(start, end).trim(), end]
}

/** Fail unless only blanks or a comment follow `text[from]`. */
function expectEnd(text: string, from: number): void {
	const rest = text.slice(from).trim()
	if (rest && !rest.startsWith("#")) throw new Error(`unexpected ${JSON.stringify(rest)}`)
}

/** A one-line flow sequence such as `["a", 'b', c]`. */
function flowSequence(text: string): string[] {
	const items: string[] = []
	let i = 1
	const skip = () => {
		while (text[i] === " " || text[i] === "\t") i++
	}
	skip()
	if (text[i] === "]") {
		expectEnd(text, i + 1)
		return items
	}
	for (;;) {
		skip()
		const [item, end] = scalarAt(text, i, ",]")
		items.push(item)
		i = end
		skip()
		if (text[i] === ",") i++
		else if (text[i] === "]") break
		else throw new Error("unterminated list")
	}
	expectEnd(text, i + 1)
	return items
}

/** A top-level front-matter value: a quoted or plain scalar, or a flow sequence. Block scalars are not supported. */
function parseValue(raw: string): string | string[] {
	const text = raw.trim()
	if (/^[|>][-+0-9]*$/.test(text)) throw new Error("block scalars are not supported")
	if (text.startsWith("[")) return flowSequence(text)
	if (text.startsWith('"') || text.startsWith("'")) {
		const [value, end] = scalarAt(text, 0, "")
		expectEnd(text, end)
		return value
	}
	return text.replace(/\s+#.*$/, "")
}

type Fields = { values: Record<string, string | string[]>; errors: Record<string, string> }

/** The top-level keys of a front-matter block. A key with no value takes the `- item` lines under it as a list. */
function fields(block: string): Fields {
	const found: Fields = { values: {}, errors: {} }
	let list: { key: string; items: string[] } | undefined
	for (const line of block.split(/\r?\n/)) {
		const item = list && LIST_ITEM.exec(line)
		if (list && item) {
			try {
				list.items.push(scalarAt(item[1] ?? "", 0, "")[0])
			} catch (error) {
				found.errors[list.key] = message(error)
			}
			continue
		}
		const match = FIELD.exec(line)
		if (!match) continue
		const key = match[1] as string
		const raw = (match[2] ?? "").trim()
		list = undefined
		if (raw === "") {
			list = { key, items: [] }
			found.values[key] = list.items
			continue
		}
		try {
			found.values[key] = parseValue(raw)
		} catch (error) {
			found.values[key] = raw
			found.errors[key] = message(error)
		}
	}
	return found
}

/** A path glob as an anchored regex: `**` spans directories, `*` and `?` stay within one, `{a,b}` and `[...]` work. */
export function globToRegExp(glob: string): RegExp {
	let out = ""
	let braces = 0
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string
		if (ch === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/"
			out += slash ? "(?:.*/)?" : ".*"
			i += slash ? 2 : 1
		} else if (ch === "*") out += "[^/]*"
		else if (ch === "?") out += "[^/]"
		else if (ch === "{") {
			braces++
			out += "(?:"
		} else if (ch === "}" && braces > 0) {
			braces--
			out += ")"
		} else if (ch === "," && braces > 0) out += "|"
		else if (ch === "[" && glob.indexOf("]", i + 2) > i) {
			const end = glob.indexOf("]", i + 2)
			const set = glob.slice(i + 1, end)
			out += `[${set.startsWith("!") ? `^${set.slice(1)}` : set}]`
			i = end
		} else out += /[.+^$()|\\[\]{}]/.test(ch) ? `\\${ch}` : ch
	}
	return new RegExp(`^${out}$`)
}

/** Scope tokens from a comma-separated string, splitting only outside parentheses and braces. */
function scopeTokens(text: string): string[] {
	const tokens: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (ch === "(" || ch === "{") depth++
		else if ((ch === ")" || ch === "}") && depth > 0) depth--
		else if (ch === "," && depth === 0) {
			tokens.push(text.slice(start, i))
			start = i + 1
		}
	}
	tokens.push(text.slice(start))
	return tokens.map((token) => token.trim()).filter(Boolean)
}

/**
 * The rule's trigger, none when it has no usable condition or scope, or a problem that stops it being enforced. `paths`
 * are the rule's globs: they gate every match on a path, so prose scopes, which have none, are dropped.
 */
function compileTrigger({ values, errors }: Fields, paths?: RegExp[]): { trigger?: Trigger; problem?: string } {
	if (values.condition === undefined) return {}
	const unreadable = ["condition", "scope"].filter((key) => errors[key])
	if (unreadable.length > 0) return { problem: unreadable.map((key) => `${key} cannot be read (${errors[key]})`).join("; ") }

	const conditions: RegExp[] = []
	const invalid: string[] = []
	for (const source of typeof values.condition === "string" ? [values.condition] : values.condition) {
		const flags = LEADING_FLAGS.exec(source)
		const pattern = flags ? source.slice(flags[0].length) : source
		if (pattern === NEVER) continue
		try {
			conditions.push(new RegExp(pattern, [...new Set(flags?.[1] ?? "")].join("")))
		} catch (error) {
			invalid.push(`${JSON.stringify(source)} (${message(error)})`)
		}
	}
	if (invalid.length > 0) return { problem: `invalid condition ${invalid.join(", ")}` }
	if (conditions.length === 0) return {}

	const scope = values.scope === undefined ? ["text", "tool"] : typeof values.scope === "string" ? scopeTokens(values.scope) : values.scope.flatMap(scopeTokens)
	const trigger: Trigger = { conditions, tools: [], text: false, thinking: false, interrupt: "always", ...(paths ? { paths } : {}) }
	for (const token of scope) {
		const tool = /^tool:([\w-]+)(?:\((.*)\))?$/.exec(token)
		if (token === "text" || token === "thinking") trigger[token] = !paths
		else if (token === "tool" || token === "toolcall") trigger.tools.push(...TOOLS.map((name) => ({ tool: name })))
		else if (tool && (TOOLS as readonly string[]).includes(tool[1] as string) && !(tool[1] === "bash" && tool[2])) {
			trigger.tools.push({ tool: tool[1] as ToolName, ...(tool[2] ? { glob: globToRegExp(tool[2]) } : {}) })
		}
	}
	if (!trigger.text && !trigger.thinking && trigger.tools.length === 0) return {}
	// A missing or unknown interruptMode keeps OMP's default, `always`, so a rule file acts the same in both harnesses.
	const mode = values.interruptMode
	if (mode === "never" || mode === "prose-only" || mode === "tool-only") trigger.interrupt = mode
	return { trigger }
}

/** The `globs` front matter: a glob, a comma-separated string or a list of them, as written and compiled. */
function compileGlobs({ values, errors }: Fields): { globs?: string[]; paths?: RegExp[]; problem?: string } {
	if (values.globs === undefined) return {}
	if (errors.globs) return { problem: `globs cannot be read (${errors.globs})` }
	const globs = typeof values.globs === "string" ? scopeTokens(values.globs) : values.globs.flatMap(scopeTokens)
	if (globs.length === 0) return {}
	const paths: RegExp[] = []
	const invalid: string[] = []
	for (const glob of globs) {
		try {
			paths.push(globToRegExp(glob))
		} catch (error) {
			invalid.push(`${JSON.stringify(glob)} (${message(error)})`)
		}
	}
	return invalid.length > 0 ? { globs, problem: `invalid glob ${invalid.join(", ")}` } : { globs, paths }
}

export function parseRule(name: string, file: string, text: string): Rule {
	const match = FRONT_MATTER.exec(text)
	const front = match ? fields(match[1] ?? "") : { values: {}, errors: {} }
	const description = front.values.description
	const globs = compileGlobs(front)
	// A rule whose globs cannot be used is not enforced at all: without its path gate, a trigger would fire too often.
	const { trigger, problem } = globs.problem ? { trigger: undefined, problem: globs.problem } : compileTrigger(front, globs.paths)
	return {
		name,
		file,
		alwaysApply: front.values.alwaysApply === "true",
		...(typeof description === "string" && description ? { description } : {}),
		...(globs.globs ? { globs: globs.globs } : {}),
		...(globs.paths ? { paths: globs.paths } : {}),
		body: (match ? text.slice(match[0].length) : text).trim(),
		...(trigger ? { trigger } : {}),
		...(problem ? { problem } : {}),
	}
}

/** Rule files under `dir` as posix paths relative to it. */
function ruleFiles(dir: string, prefix = ""): string[] {
	const found: string[] = []
	for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) found.push(...ruleFiles(dir, relativePath))
		else if (RULE_FILE.test(entry.name)) found.push(relativePath)
	}
	return found
}

/** The rules under `dir`, ordered by file name; none when the directory is missing. */
export function loadRules(dir: string): Rule[] {
	if (!existsSync(dir)) return []
	return ruleFiles(dir)
		.sort()
		.map((file) => parseRule(file.replace(RULE_FILE, ""), join(dir, file), readFileSync(join(dir, file), "utf8")))
}

const ruleText = (rule: Rule) => `## Rule: ${rule.name}\n\n${rule.body}`

/** The text of the rules' system prompt section: always-on rules in full, then an index of the others. Empty without rules. */
export function renderRules(rules: readonly Rule[]): string {
	const sections = rules.filter((rule) => rule.alwaysApply).map(ruleText)
	const index = rules
		.filter((rule) => !rule.alwaysApply)
		.map((rule) => `- ${rule.name}${rule.globs ? ` (${rule.globs.join(", ")})` : ""}: ${rule.description ?? "no description"} (${rule.file})`)
	if (index.length > 0) sections.push(["## Rules to read on demand", "", "Read a rule's file before work that its description covers.", "", ...index].join("\n"))
	return sections.join("\n\n")
}

/** What a condition is tested against: bash's command (also as its JSON arguments), edit's new text, write's content, read's path. */
function callTexts(tool: ToolName, input: Record<string, unknown>): string[] {
	const edits = Array.isArray(input.edits) ? input.edits.map((edit) => (typeof edit === "object" && edit !== null ? (edit as Record<string, unknown>).newText : undefined)) : []
	const own =
		tool === "bash" ? [input.command, JSON.stringify(input)] : tool === "write" ? [input.content] : tool === "read" ? [input.path] : [input.newText, ...edits]
	return own.filter((text): text is string => typeof text === "string")
}

/** The call's `path` as given, absolute, relative to the cwd, and as a base name; none without a path. */
function pathCandidates(input: Record<string, unknown>, cwd: string): string[] {
	if (typeof input.path !== "string") return []
	const absolute = resolve(cwd, input.path)
	return [input.path, absolute, relative(cwd, absolute), basename(absolute)]
}

/** Whether a `read`, `edit` or `write` call names a file that one of `paths` matches. */
export function matchesFile(paths: readonly RegExp[], toolName: string, input: Record<string, unknown>, cwd: string): boolean {
	if (!FILE_TOOLS.includes(toolName)) return false
	const candidates = pathCandidates(input, cwd)
	return paths.some((path) => candidates.some((candidate) => path.test(candidate)))
}

/**
 * Whether a tool call falls under the trigger: a scope names the tool, its glob (if any) takes the path, the rule's
 * globs (if any) take the path, and a condition matches.
 */
export function matchesToolCall(trigger: Trigger, toolName: string, input: Record<string, unknown>, cwd: string): boolean {
	const scopes = trigger.tools.filter((scope) => scope.tool === toolName)
	if (scopes.length === 0) return false
	const paths = pathCandidates(input, cwd)
	if (!scopes.some((scope) => !scope.glob || paths.some((candidate) => scope.glob?.test(candidate)))) return false
	if (trigger.paths && !trigger.paths.some((path) => paths.some((candidate) => path.test(candidate)))) return false
	const texts = callTexts(toolName as ToolName, input)
	return trigger.conditions.some((condition) => texts.some((text) => condition.test(text)))
}

export interface Deps {
	/** The pi tree holding `rules/`; defaults to the parent of the `_kit` directory. */
	root?: string
	/** Reports a rule whose trigger cannot be enforced. pi's extension API has no logger, so the default is `console.warn`. */
	warn?: (message: string) => void
}

/** The package a pi tree belongs to: the `name` in its package.json, or the directory's name without one. */
export function packageId(root: string): string {
	const manifest = join(root, "package.json")
	const name = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name : undefined
	return typeof name === "string" && name ? name : basename(root)
}

/**
 * The system prompt section that holds a package's rules. pi accepts section names matching `[a-z][a-z0-9_-]*` and
 * renders each section as `<name>…</name>`; the `rules_` prefix keeps it clear of pi's own sections, one of which is `rules`.
 */
export function sectionName(id: string): string {
	return `rules_${id.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_-]+/g, "_")}`
}

/** The copy of each package that owns a session, keyed by session id and package, across every copy in this process. */
const OWNERS = Symbol.for("@srobroek/harness-kit/pi-rules/owners")

function owners(): Map<string, object> {
	const store = globalThis as unknown as Record<symbol, Map<string, object> | undefined>
	store[OWNERS] ??= new Map()
	return store[OWNERS]
}

export default function rulesExtension(pi: Api, deps: Deps = {}): void {
	const root = deps.root ?? join(dirname(fileURLToPath(import.meta.url)), "..")
	const warn = deps.warn ?? ((text: string) => console.warn(`rules: ${text}`))
	const rules = loadRules(join(root, "rules"))
	if (rules.length === 0) return
	for (const rule of rules) if (rule.problem) warn(`${rule.file}: ${rule.problem}; the rule stays in the index but is not enforced`)
	const id = packageId(root)
	const section = sectionName(id)
	const text = renderRules(rules)

	// pi dedupes an extension path, but two copies of the package (say one installed for the user, one for the project)
	// both load. The first copy to see a session claims it; the others leave that session alone.
	const self = {}
	const sessionKey = (ctx: Context) => `${ctx.sessionManager.getSessionId()}\n${id}`
	const owns = (ctx: Context) => {
		const key = sessionKey(ctx)
		const owner = owners().get(key) ?? self
		owners().set(key, owner)
		return owner === self
	}
	pi.on("session_shutdown", (_event, ctx) => {
		const key = sessionKey(ctx)
		if (owners().get(key) === self) owners().delete(key)
	})
	// pi rebuilds the sections for each run and diffs them against what the model has, so the same text sends nothing.
	pi.on("before_agent_start", (event, ctx) => {
		if (owns(ctx)) event.systemPromptOptions.sections[section] = text
	})

	const toolRules = rules.filter((rule) => (rule.trigger?.tools.length ?? 0) > 0)
	const proseRules = rules.filter((rule) => rule.trigger?.text || rule.trigger?.thinking)
	// A triggered rule's globs are its path gate, so only an untriggered one is delivered by path.
	const fileRules = rules.flatMap((rule) => (!rule.alwaysApply && !rule.trigger && !rule.problem && rule.paths ? [{ rule, paths: rule.paths }] : []))
	if (toolRules.length === 0 && proseRules.length === 0 && fileRules.length === 0) return

	/** Rules delivered in this session; each fires once. */
	const fired = new Set<string>()
	/** The reminder each tool call gets appended to its result: its non-interrupting rules and the rules for its file. */
	const reminders = new Map<string, string>()
	/** Streamed text and thinking of the current assistant message, by content block. */
	const buffers = new Map<string, string>()
	pi.on("session_start", () => {
		fired.clear()
		reminders.clear()
		buffers.clear()
	})

	if (toolRules.length > 0 || fileRules.length > 0) {
		pi.on("tool_call", (event, ctx) => {
			if (!owns(ctx)) return undefined
			const matched = toolRules.filter((rule) => !fired.has(rule.name) && rule.trigger && matchesToolCall(rule.trigger, event.toolName, event.input, ctx.cwd))
			const blocking = matched.filter((rule) => rule.trigger?.interrupt === "always" || rule.trigger?.interrupt === "tool-only")
			if (blocking.length > 0) {
				// A blocked call gets no result, so the other rules wait for the retry.
				for (const rule of blocking) fired.add(rule.name)
				return { block: true, reason: ["This call was blocked before it ran, by the rule below.", ...blocking.map(ruleText), "Retry the call if it still applies."].join("\n\n") }
			}
			const covered = fileRules.filter(({ rule, paths }) => !fired.has(rule.name) && matchesFile(paths, event.toolName, event.input, ctx.cwd)).map(({ rule }) => rule)
			for (const rule of [...matched, ...covered]) fired.add(rule.name)
			const parts = [
				...(matched.length > 0 ? ["This call matched the rule below.", ...matched.map(ruleText)] : []),
				...(covered.length > 0 ? [`This call's file falls under the rule${covered.length > 1 ? "s" : ""} below.`, ...covered.map(ruleText)] : []),
			]
			if (parts.length > 0) reminders.set(event.toolCallId, parts.join("\n\n"))
			return undefined
		})
		pi.on("tool_result", (event) => {
			const reminder = reminders.get(event.toolCallId)
			if (reminder === undefined) return undefined
			reminders.delete(event.toolCallId)
			return { content: [...event.content, { type: "text", text: reminder }], ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) }
		})
	}

	if (proseRules.length > 0) {
		pi.on("message_start", (event) => {
			if (event.message?.role === "assistant") buffers.clear()
		})
		pi.on("message_update", (event, ctx) => {
			const update = event.assistantMessageEvent
			const source: Source | undefined = update?.type.startsWith("text_") ? "text" : update?.type.startsWith("thinking_") ? "thinking" : undefined
			if (!update || !source || !owns(ctx)) return
			const key = `${source}:${update.contentIndex ?? 0}`
			const buffer = update.type.endsWith("_delta") ? (buffers.get(key) ?? "") + (update.delta ?? "") : update.type.endsWith("_end") ? update.content : undefined
			if (buffer === undefined) return
			buffers.set(key, buffer)
			for (const rule of proseRules) {
				if (fired.has(rule.name) || !rule.trigger?.[source] || !rule.trigger.conditions.some((condition) => condition.test(buffer))) continue
				fired.add(rule.name)
				const content = [`Your ${source === "text" ? "reply" : "reasoning"} matched the rule below.`, ruleText(rule)].join("\n\n")
				pi.sendMessage({ customType: "harness-kit-rule", content, display: true }, { deliverAs: "steer" })
			}
		})
	}
}
