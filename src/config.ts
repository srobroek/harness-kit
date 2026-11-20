// The per-repo settings in harness-kit.json. Everything the generator used to hold as a constant lives here.

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fail, isRecord, nonEmptyString } from "./util"

export const CONFIG_FILE = "harness-kit.json"

/** Every harness the generator can target, in the canonical order used for output. */
export const KNOWN_HARNESSES = ["opencode", "claude", "omp"] as const
export type Harness = (typeof KNOWN_HARNESSES)[number]

/** Every inventory kind the generator can report, in canonical order. */
export const KNOWN_KINDS = ["skills", "agents", "commands", "rules", "templates", "styles", "hooks", "tools", "extensions", "mcp"] as const
export type Kind = (typeof KNOWN_KINDS)[number]

export type Config = {
  marketplace: { name: string; description: string; owner: { name: string } }
  harnesses: Harness[]
  /** Directories under plugins/<name>/common/ that are copied into each harness tree. */
  commonDirs: string[]
  kinds: Kind[]
  /** Key in plugins/<name>/package.json that holds the plugin's own settings. */
  pluginKey: string
  /** npm scope of the generated OMP package name. */
  ompScope: string
  /** Names the generator in the note at the top of generated Markdown files. */
  generatedBy: string
  claude: {
    /** `harness-kit validate-claude` runs `claude plugin validate --strict` when true. */
    strict: boolean
    /** Written to a Claude manifest whose package.json sets no author. */
    author?: { name: string }
    /** Written to a Claude manifest whose package.json sets no license. */
    license?: string
  }
  omp: { packageType?: "module" | "commonjs" }
}

const TOP_KEYS = ["marketplace", "harnesses", "commonDirs", "kinds", "pluginKey", "ompScope", "generatedBy", "claude", "omp"]
const DIR_NAME = /^[a-z0-9][a-z0-9._-]*$/
const PACKAGE_SCOPE = /^@[a-z0-9][a-z0-9._-]*$/

const DEFAULT_KINDS: Kind[] = ["skills", "agents", "commands", "rules", "hooks", "tools", "extensions", "mcp"]

function onlyKeys(where: string, field: string, value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) fail(where, `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${field}${k}"`).join(", ")} (allowed: ${allowed.join(", ")})`)
}

/** A list of unique strings drawn from `allowed` (when given), returned in the order of `allowed`. */
function pickList<T extends string>(where: string, field: string, noun: string, raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw) || raw.length === 0) fail(where, `"${field}" must be a non-empty array (use ${allowed.join(", ")})`)
  for (const item of raw) {
    if (!(allowed as readonly unknown[]).includes(item)) fail(where, `unknown ${noun} "${String(item)}" in "${field}" (use ${allowed.join(", ")})`)
  }
  if (new Set(raw).size !== raw.length) fail(where, `"${field}" lists a value twice`)
  return allowed.filter((item) => raw.includes(item))
}

/** Validate a parsed harness-kit.json and fill in defaults. `where` names the file in error messages. */
export function resolveConfig(raw: unknown, where = CONFIG_FILE): Config {
  if (!isRecord(raw)) fail(where, "must be a JSON object")
  onlyKeys(where, "", raw, TOP_KEYS)

  const market = raw.marketplace
  if (!isRecord(market)) fail(where, 'missing "marketplace" object ({ name, description, owner: { name } })')
  onlyKeys(where, "marketplace.", market, ["name", "description", "owner"])
  const name = nonEmptyString(where, "marketplace.name", market.name)
  const description = nonEmptyString(where, "marketplace.description", market.description)
  if (!isRecord(market.owner)) fail(where, '"marketplace.owner" must be an object with a name')
  const owner = { name: nonEmptyString(where, "marketplace.owner.name", market.owner.name) }

  const harnesses = raw.harnesses === undefined ? [...KNOWN_HARNESSES] : pickList(where, "harnesses", "harness", raw.harnesses, KNOWN_HARNESSES)

  let commonDirs = ["skills", "rules"]
  if (raw.commonDirs !== undefined) {
    if (!Array.isArray(raw.commonDirs) || raw.commonDirs.length === 0) fail(where, '"commonDirs" must be a non-empty array of directory names')
    for (const dir of raw.commonDirs) {
      if (typeof dir !== "string" || !DIR_NAME.test(dir)) fail(where, `"commonDirs" entry ${JSON.stringify(dir)} must be a plain directory name`)
    }
    if (new Set(raw.commonDirs).size !== raw.commonDirs.length) fail(where, '"commonDirs" lists a directory twice')
    if (raw.commonDirs.includes("_kit")) fail(where, '"commonDirs" cannot list "_kit", which holds the vendored runtime modules')
    commonDirs = raw.commonDirs as string[]
  }

  const kinds = raw.kinds === undefined ? DEFAULT_KINDS : pickList(where, "kinds", "kind", raw.kinds, KNOWN_KINDS)

  const pluginKey = raw.pluginKey === undefined ? "agent-plugins" : nonEmptyString(where, "pluginKey", raw.pluginKey)
  const ompScope = raw.ompScope === undefined ? "@agent-plugins" : nonEmptyString(where, "ompScope", raw.ompScope)
  if (!PACKAGE_SCOPE.test(ompScope)) fail(where, `"ompScope" must look like "@scope", got "${ompScope}"`)
  const generatedBy = raw.generatedBy === undefined ? "harness-kit build" : nonEmptyString(where, "generatedBy", raw.generatedBy)

  const claude: Config["claude"] = { strict: true }
  if (raw.claude !== undefined) {
    if (!isRecord(raw.claude)) fail(where, '"claude" must be an object')
    onlyKeys(where, "claude.", raw.claude, ["strict", "author", "license"])
    if (raw.claude.strict !== undefined) {
      if (typeof raw.claude.strict !== "boolean") fail(where, '"claude.strict" must be true or false')
      claude.strict = raw.claude.strict
    }
    if (raw.claude.author !== undefined) {
      if (!isRecord(raw.claude.author)) fail(where, '"claude.author" must be an object with a name')
      claude.author = { name: nonEmptyString(where, "claude.author.name", raw.claude.author.name) }
    }
    if (raw.claude.license !== undefined) claude.license = nonEmptyString(where, "claude.license", raw.claude.license)
  }

  const omp: Config["omp"] = {}
  if (raw.omp !== undefined) {
    if (!isRecord(raw.omp)) fail(where, '"omp" must be an object')
    onlyKeys(where, "omp.", raw.omp, ["packageType"])
    if (raw.omp.packageType !== undefined) {
      if (raw.omp.packageType !== "module" && raw.omp.packageType !== "commonjs") fail(where, '"omp.packageType" must be "module" or "commonjs"')
      omp.packageType = raw.omp.packageType
    }
  }

  return {
    marketplace: { name, description, owner },
    harnesses,
    commonDirs,
    kinds,
    pluginKey,
    ompScope,
    generatedBy,
    claude,
    omp,
  }
}

/** Read and validate <root>/harness-kit.json. */
export function loadConfig(root: string): Config {
  const file = path.join(root, CONFIG_FILE)
  if (!existsSync(file)) fail(CONFIG_FILE, `not found in ${root}; create it (see the README, "Config")`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    fail(CONFIG_FILE, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  return resolveConfig(raw)
}

/** The nearest directory at or above `start` that holds a harness-kit.json. */
export function findRoot(start: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}
