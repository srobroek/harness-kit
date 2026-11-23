import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * A pi and OMP extension that checks the external CLIs a plugin declares in its `prerequisites`. harness-kit writes the
 * plugin's list to `_kit/prereqs.json` and vendors this file as `_kit/prereqs.ts`. Both harnesses load it from the
 * package's extension list, because they share the `session_start` event and `ctx.ui.notify`.
 *
 * On `session_start` it looks each `bin` up without a shell: an executable file of that name in the `PATH` directories,
 * after the `node_modules/.bin` directories of the package and its ancestors when the prerequisite names an npm package
 * (`install.npm`). With a `version` range it runs `<bin> --version` (2 s timeout) and compares the first version-looking
 * token of the output. The check runs once per process, and the result is cached.
 *
 * Every tool that is missing, too old, or whose version cannot be read goes into one notice. A session with a UI gets it
 * as a warning through `ctx.ui.notify`. Without a UI, one line goes to stderr, at most once per process, and not after a
 * UI notice: in OMP, subagent sessions have no UI and share the process. When every tool is present, nothing is reported.
 *
 * A gate extension of the plugin fails closed with `missingRequired()` and `prereqMessage(bin)`, imported from
 * `../_kit/prereqs.ts`:
 *
 *     const missing = missingRequired()
 *     if (missing.length > 0) return { block: true, reason: missing.map((bin) => prereqMessage(bin)).join("\n") }
 */

export interface Install {
	/** A mise tool, installed with `mise use -g <mise>`. */
	mise?: string
	url?: string
	/** `<name>@<range>`: the npm package that provides the bin. Its `node_modules/.bin` is searched before PATH. */
	npm?: string
}

export interface Prerequisite {
	bin: string
	/** What the plugin uses the tool for, shown in the notice. */
	for: string
	/** The plugin's gates cannot work without it. */
	required: boolean
	install: Install
	/** A semver range that the version in `<bin> --version` must satisfy. */
	version?: string
}

/** The contents of `_kit/prereqs.json`. */
export interface Manifest {
	plugin: string
	prerequisites: Prerequisite[]
}

/** An unmet prerequisite: not found, or a version that does not satisfy the range (`found` is absent when unreadable). */
export interface Finding {
	prerequisite: Prerequisite
	problem: "missing" | "version"
	found?: string
}

export type Env = Record<string, string | undefined>

export interface Deps {
	/** The package tree holding `_kit/prereqs.json`; defaults to the parent of the `_kit` directory. */
	root?: string
	env?: Env
	/** Writes the notice of a session without a UI; defaults to one line on stderr. */
	stderr?: (line: string) => void
}

interface Context {
	hasUI: boolean
	ui: { notify(message: string, type: "warning"): void }
}

/** The slice of the pi and OMP extension API this file uses. */
interface Api {
	on(event: "session_start", handler: (event: unknown, ctx: Context) => void): void
}

type Version = readonly [number, number, number]
type Comparator = { op: "<" | "<=" | ">" | ">="; version: Version }

const VERSION_TIMEOUT_MS = 2000
const OPERATOR = /^(<=|>=|<|>|=|\^|~)?v?(.+)$/
const NUMBER = /^\d+$/
const WILDCARD = /^[xX*]$/
const VERSION_TOKEN = /(\d+)\.(\d+)(?:\.(\d+))?/
/** Matches nothing: no version is below 0.0.0. */
const NOTHING: Comparator = { op: "<", version: [0, 0, 0] }

function compare(a: Version, b: Version): number {
	for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number)
	return 0
}

/** The numbers of a partial version (`1`, `1.2`, `1.2.3`, `1.x`, `*`): wildcards end it. Undefined when malformed. */
function partial(text: string): number[] | undefined {
	const parts = text.split(".")
	if (parts.length > 3 || !parts.every((part) => NUMBER.test(part) || WILDCARD.test(part))) return undefined
	const wild = parts.findIndex((part) => WILDCARD.test(part))
	if (wild === -1) return parts.map(Number)
	return parts.slice(wild).every((part) => WILDCARD.test(part)) ? parts.slice(0, wild).map(Number) : undefined
}

/** One range item as comparators, with npm's meaning for partial versions, `^` and `~`. */
function comparators(op: string, numbers: number[]): Comparator[] {
	if (numbers.length === 0) return op === "<" || op === ">" ? [NOTHING] : []
	const [major = 0, minor = 0, patch = 0] = numbers
	const at: Version = [major, minor, patch]
	const exact = numbers.length === 3
	// The first version past the given parts: 1 gives 2.0.0, 1.2 and 1.2.3 give 1.3.0.
	const next: Version = numbers.length === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0]
	switch (op) {
		case ">=":
			return [{ op: ">=", version: at }]
		case ">":
			return [exact ? { op: ">", version: at } : { op: ">=", version: next }]
		case "<":
			return [{ op: "<", version: at }]
		case "<=":
			return [exact ? { op: "<=", version: at } : { op: "<", version: next }]
		case "~":
			return [{ op: ">=", version: at }, { op: "<", version: next }]
		case "^": {
			const upper: Version = major > 0 || numbers.length === 1 ? [major + 1, 0, 0] : minor > 0 || numbers.length === 2 ? [0, minor + 1, 0] : [0, 0, patch + 1]
			return [{ op: ">=", version: at }, { op: "<", version: upper }]
		}
		default:
			return exact ? [{ op: ">=", version: at }, { op: "<=", version: at }] : [{ op: ">=", version: at }, { op: "<", version: next }]
	}
}

/**
 * A semver range as alternatives (`||`) of comparators that must all hold. Supported: `<`, `<=`, `>`, `>=`, `=`, `^`, `~`,
 * plain and partial versions, and `x`/`*` wildcards. Versions are numbers only. Throws on anything else.
 */
export function parseRange(range: string): Comparator[][] {
	return range.split("||").map((alternative) => {
		const items = alternative.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1")
		if (!items) throw new Error(`${JSON.stringify(range)} has an empty alternative`)
		return items.split(/\s+/).flatMap((item) => {
			const match = OPERATOR.exec(item)
			const numbers = match ? partial(match[2] as string) : undefined
			if (!match || !numbers) throw new Error(`${JSON.stringify(range)} is not a supported semver range: cannot read "${item}" (use comparators such as >=1.3.0, ^2.1 or ~1.4.2)`)
			return comparators(match[1] ?? "", numbers)
		})
	})
}

/** The first version-looking token (`1.2` or `1.2.3`) in a command's output, as `x.y.z`. A suffix such as `-rc.1` is ignored. */
export function versionIn(output: string): string | undefined {
	const match = VERSION_TOKEN.exec(output)
	return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? 0)}` : undefined
}

/** Whether an `x.y.z` version satisfies a range that `parseRange` accepts. */
export function satisfies(version: string, range: string): boolean {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number)
	const at: Version = [major, minor, patch]
	return parseRange(range).some((alternative) =>
		alternative.every(({ op, version: bound }) => {
			const order = compare(at, bound)
			return op === "<" ? order < 0 : op === "<=" ? order <= 0 : op === ">" ? order > 0 : order >= 0
		}),
	)
}

/** Directories searched for a prerequisite, in order. Relative and empty PATH entries are skipped. */
export function searchPath(prerequisite: Prerequisite, root: string, env: Env): string[] {
	const dirs: string[] = []
	if (prerequisite.install.npm) {
		for (let dir = root; ; dir = dirname(dir)) {
			dirs.push(join(dir, "node_modules", ".bin"))
			if (dirname(dir) === dir) break
		}
	}
	dirs.push(...(env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir)))
	return dirs
}

/** The first executable file named `bin` in `dirs`, like `which`. */
export function which(bin: string, dirs: readonly string[]): string | undefined {
	for (const dir of dirs) {
		const file = join(dir, bin)
		try {
			if (!statSync(file).isFile()) continue
			accessSync(file, constants.X_OK)
			return file
		} catch {
			// Not here, or not executable: keep looking.
		}
	}
	return undefined
}

function readVersion(file: string): string | undefined {
	const run = spawnSync(file, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] })
	if (run.error) return undefined
	return versionIn(`${run.stdout ?? ""}\n${run.stderr ?? ""}`)
}

/** The unmet prerequisites of a manifest, in its order. Runs the lookups and version commands on every call. */
export function check(manifest: Manifest, root: string, env: Env): Finding[] {
	return manifest.prerequisites.flatMap((prerequisite): Finding[] => {
		const file = which(prerequisite.bin, searchPath(prerequisite, root, env))
		if (!file) return [{ prerequisite, problem: "missing" }]
		if (!prerequisite.version) return []
		const found = readVersion(file)
		if (found === undefined) return [{ prerequisite, problem: "version" }]
		return satisfies(found, prerequisite.version) ? [] : [{ prerequisite, problem: "version", found }]
	})
}

/** The ways to install a tool: `mise use -g` first when the plugin names a mise tool, then npm, then the URL. */
export function installHint(install: Install): string {
	const ways = [...(install.mise ? [`mise use -g ${install.mise}`] : []), ...(install.npm ? [`npm install -g ${install.npm}`] : []), ...(install.url ? [`see ${install.url}`] : [])]
	return ways.join(", or ")
}

/** One unmet prerequisite: what it is for, what is wrong, and how to install it. */
export function describeFinding({ prerequisite, problem, found }: Finding): string {
	const where = prerequisite.install.npm ? "not in node_modules/.bin or on PATH" : "not on PATH"
	const wrong = problem === "missing" ? where : found ? `version ${found} does not satisfy ${prerequisite.version}` : `cannot read its version from \`${prerequisite.bin} --version\` (needs ${prerequisite.version})`
	return `${prerequisite.bin} (${prerequisite.required ? "required, " : ""}for ${prerequisite.for}): ${wrong}; install: ${installHint(prerequisite.install)}`
}

const defaultRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..")

const cache = new Map<string, { manifest: Manifest; findings: Finding[] }>()
/** Packages whose notice this process has shown or written. */
const reported = new Set<string>()

/** The manifest and its unmet prerequisites, checked once per package root and PATH in this process. */
function status(deps: Deps): { manifest: Manifest; findings: Finding[] } {
	const root = deps.root ?? defaultRoot()
	const env = deps.env ?? process.env
	const key = `${root}\0${env.PATH ?? ""}`
	let entry = cache.get(key)
	if (!entry) {
		const manifest = JSON.parse(readFileSync(join(root, "_kit", "prereqs.json"), "utf8")) as Manifest
		entry = { manifest, findings: check(manifest, root, env) }
		cache.set(key, entry)
	}
	return entry
}

/** The bins of required prerequisites that are missing, too old, or of unreadable version. Gates block on a non-empty list. */
export function missingRequired(deps: Deps = {}): string[] {
	return status(deps)
		.findings.filter((finding) => finding.prerequisite.required)
		.map((finding) => finding.prerequisite.bin)
}

/** The message a gate gives for one declared prerequisite: what is wrong with it and how to install it. */
export function prereqMessage(bin: string, deps: Deps = {}): string {
	const { manifest, findings } = status(deps)
	const prerequisite = manifest.prerequisites.find((item) => item.bin === bin)
	if (!prerequisite) throw new Error(`${manifest.plugin} declares no prerequisite "${bin}"`)
	const finding = findings.find((item) => item.prerequisite.bin === bin)
	return finding ? `${manifest.plugin} needs ${describeFinding(finding)}` : `${manifest.plugin}: ${bin} is available`
}

export default function prereqsExtension(pi: Api, deps: Deps = {}): void {
	const stderr = deps.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`))
	pi.on("session_start", (_event, ctx) => {
		const { manifest, findings } = status(deps)
		if (findings.length === 0) return
		const heading = `${manifest.plugin}: prerequisites not met`
		const key = deps.root ?? defaultRoot()
		if (ctx.hasUI) {
			reported.add(key)
			ctx.ui.notify([`${heading}:`, ...findings.map((finding) => `- ${describeFinding(finding)}`)].join("\n"), "warning")
			return
		}
		if (reported.has(key)) return
		reported.add(key)
		stderr(`${heading}: ${findings.map(describeFinding).join("; ")}`)
	})
}
