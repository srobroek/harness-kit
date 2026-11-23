// The per-repo settings in harness-kit.json. Everything the generator used to hold as a constant lives here.

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
// The prerequisite check's own types and range grammar, so the generator accepts exactly what the vendored module reads.
import { type Companion, type Prerequisite, parseRange } from "../runtime/pi/prereqs"
import { fail, httpUrl, isRecord, nonEmptyString } from "./util"

export const CONFIG_FILE = "harness-kit.json"

/** Every harness the generator can target, in the canonical order used for output. */
export const KNOWN_HARNESSES = ["opencode", "claude", "omp", "pi"] as const
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
  /** Repo-level directory whose items plugins list in `shared`; its layout follows `commonDirs` (shared/agents/x.md). */
  sharedDir: string
  /** Key in plugins/<name>/package.json that holds the plugin's own settings. */
  pluginKey: string
  /** npm scope of the generated OMP package name. */
  ompScope: string
  /** npm scope of the generated pi package name. */
  piScope: string
  /** Put before the plugin name in the pi package name, unless the plugin sets `piName`. */
  piPrefix: string
  /** Names the generator in the note at the top of generated Markdown files. */
  generatedBy: string
  claude: {
    /** `harness-kit validate-claude` runs `claude plugin validate --strict` when true. */
    strict: boolean
    /** Written to a Claude manifest whose package.json sets no author. */
    author?: { name: string; url?: string }
    /** Written to a Claude manifest whose package.json sets no license. */
    license?: string
    /** Default `homepage` and `repository` of every Claude manifest and marketplace entry; a plugin's `claude` settings override them. */
    homepage?: string
    repository?: string
  }
  omp: { packageType?: "module" | "commonjs" }
  /** `publish`: the generated pi `package.json` is ready for npm (see the README, "Publishing pi packages to npm"). */
  pi: { publish: boolean }
}

const TOP_KEYS = ["marketplace", "harnesses", "commonDirs", "kinds", "sharedDir", "pluginKey", "ompScope", "piScope", "piPrefix", "generatedBy", "claude", "omp", "pi"]
const DIR_NAME = /^[a-z0-9][a-z0-9._-]*$/
const PACKAGE_SCOPE = /^@[a-z0-9][a-z0-9._-]*$/
/** The part of an npm package name after the scope: lowercase and URL-safe, starting with a letter or digit. */
export const NPM_NAME = /^[a-z0-9][a-z0-9._-]*$/
/** npm's limit on the length of a package name, scope included. */
export const NPM_NAME_MAX = 214

const DEFAULT_KINDS: Kind[] = ["skills", "agents", "commands", "rules", "hooks", "tools", "extensions", "mcp"]

function onlyKeys(where: string, field: string, value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) fail(where, `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${field}${k}"`).join(", ")} (allowed: ${allowed.join(", ")})`)
}

export type { Companion, Prerequisite }

const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
/** An npm package name, scoped or not. */
const PACKAGE_NAME = "(?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*"
const NPM_PACKAGE = new RegExp(`^${PACKAGE_NAME}$`)
const NPM_SPEC = new RegExp(`^(${PACKAGE_NAME})@(.+)$`)

/** The package and range of an `install.npm` spec such as `repomix@^1.2.0`; undefined when it is not one. */
export function npmSpec(spec: string): { name: string; range: string } | undefined {
  const match = NPM_SPEC.exec(spec)
  return match ? { name: match[1] as string, range: match[2] as string } : undefined
}

/** A semver range the prerequisite check can evaluate. */
function versionRange(where: string, field: string, raw: unknown): string {
  const range = nonEmptyString(where, field, raw)
  try {
    parseRange(range)
  } catch (error) {
    fail(where, `"${field}": ${error instanceof Error ? error.message : String(error)}`)
  }
  return range
}

/**
 * Validate a plugin's `prerequisites` list and fill in `required: false`. `field` is the key path errors name, such as
 * `agent-plugins.prerequisites`. Keys come back in one order, so the generated files do not depend on the author's.
 */
export function readPrerequisites(where: string, field: string, raw: unknown): Prerequisite[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) fail(where, `"${field}" must be a non-empty list of { bin, for, install } objects`)
  const seen = new Set<string>()
  return raw.map((item: unknown, index): Prerequisite => {
    const at = `${field}[${index}]`
    if (!isRecord(item)) fail(where, `"${at}" must be an object with bin, for and install`)
    onlyKeys(where, `${at}.`, item, ["bin", "for", "required", "install", "version"])
    const bin = nonEmptyString(where, `${at}.bin`, item.bin)
    if (!BIN_NAME.test(bin)) fail(where, `"${at}.bin" must be a command name without a path, got ${JSON.stringify(bin)}`)
    if (seen.has(bin)) fail(where, `"${field}" lists "${bin}" twice`)
    seen.add(bin)
    const purpose = nonEmptyString(where, `${at}.for`, item.for)
    if (/[\r\n]/.test(purpose)) fail(where, `"${at}.for" must be one line`)
    if (item.required !== undefined && typeof item.required !== "boolean") fail(where, `"${at}.required" must be true or false`)

    const raw = item.install
    if (!isRecord(raw)) fail(where, `"${at}.install" must be an object with "mise", "url" or both`)
    onlyKeys(where, `${at}.install.`, raw, ["mise", "url", "npm"])
    const install: Prerequisite["install"] = {}
    if (raw.mise !== undefined) {
      install.mise = nonEmptyString(where, `${at}.install.mise`, raw.mise)
      if (/\s/.test(install.mise)) fail(where, `"${at}.install.mise" must be one mise tool, such as "aqua:owner/repo", got ${JSON.stringify(install.mise)}`)
    }
    if (raw.url !== undefined) install.url = httpUrl(where, `${at}.install.url`, raw.url)
    if (raw.npm !== undefined) {
      const spec = nonEmptyString(where, `${at}.install.npm`, raw.npm)
      const parsed = npmSpec(spec)
      if (!parsed) fail(where, `"${at}.install.npm" must be "<package>@<range>", such as "repomix@^1.2.0", got ${JSON.stringify(spec)}`)
      versionRange(where, `${at}.install.npm`, parsed.range)
      install.npm = spec
    }
    if (install.mise === undefined && install.url === undefined) fail(where, `"${at}.install" needs "mise", "url" or both`)

    const prerequisite: Prerequisite = { bin, for: purpose, required: item.required === true, install }
    if (item.version !== undefined) prerequisite.version = versionRange(where, `${at}.version`, item.version)
    return prerequisite
  })
}

/**
 * Validate a plugin's `companions` list (pi packages it works with) and fill in `required: false`. `field` is the key
 * path errors name, such as `agent-plugins.companions`. Keys come back in one order.
 */
export function readCompanions(where: string, field: string, raw: unknown): Companion[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) fail(where, `"${field}" must be a non-empty list of { package, for } objects`)
  const seen = new Set<string>()
  return raw.map((item: unknown, index): Companion => {
    const at = `${field}[${index}]`
    if (!isRecord(item)) fail(where, `"${at}" must be an object with package and for`)
    onlyKeys(where, `${at}.`, item, ["package", "for", "required", "range"])
    const name = nonEmptyString(where, `${at}.package`, item.package)
    if (!NPM_PACKAGE.test(name) || name.length > NPM_NAME_MAX) fail(where, `"${at}.package" must be an npm package name, such as "@scope/pi-tools", got ${JSON.stringify(name)}`)
    if (seen.has(name)) fail(where, `"${field}" lists "${name}" twice`)
    seen.add(name)
    const purpose = nonEmptyString(where, `${at}.for`, item.for)
    if (/[\r\n]/.test(purpose)) fail(where, `"${at}.for" must be one line`)
    if (item.required !== undefined && typeof item.required !== "boolean") fail(where, `"${at}.required" must be true or false`)
    const companion: Companion = { package: name, for: purpose, required: item.required === true }
    if (item.range !== undefined) companion.range = versionRange(where, `${at}.range`, item.range)
    return companion
  })
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

  const sharedDir = raw.sharedDir === undefined ? "shared" : nonEmptyString(where, "sharedDir", raw.sharedDir)
  if (!DIR_NAME.test(sharedDir)) fail(where, `"sharedDir" must be a plain directory name, got "${sharedDir}"`)
  if (["plugins", "_kit", "node_modules"].includes(sharedDir) || commonDirs.includes(sharedDir)) fail(where, `"sharedDir" cannot be "${sharedDir}"`)

  const pluginKey = raw.pluginKey === undefined ? "agent-plugins" : nonEmptyString(where, "pluginKey", raw.pluginKey)
  const ompScope = raw.ompScope === undefined ? "@agent-plugins" : nonEmptyString(where, "ompScope", raw.ompScope)
  if (!PACKAGE_SCOPE.test(ompScope)) fail(where, `"ompScope" must look like "@scope", got "${ompScope}"`)
  const piScope = raw.piScope === undefined ? "@agent-plugins" : nonEmptyString(where, "piScope", raw.piScope)
  if (!PACKAGE_SCOPE.test(piScope)) fail(where, `"piScope" must look like "@scope", got "${piScope}"`)
  const piPrefix = raw.piPrefix === undefined ? "" : raw.piPrefix
  // A plugin name is letters, digits and hyphens, so a prefix that could start a package name gives a valid name.
  if (typeof piPrefix !== "string" || (piPrefix !== "" && !NPM_NAME.test(piPrefix))) {
    fail(where, `"piPrefix" must be lowercase letters, digits, ".", "_" or "-", starting with a letter or digit, got ${JSON.stringify(piPrefix)}`)
  }
  const generatedBy = raw.generatedBy === undefined ? "harness-kit build" : nonEmptyString(where, "generatedBy", raw.generatedBy)

  const claude: Config["claude"] = { strict: true }
  if (raw.claude !== undefined) {
    if (!isRecord(raw.claude)) fail(where, '"claude" must be an object')
    onlyKeys(where, "claude.", raw.claude, ["strict", "author", "license", "homepage", "repository"])
    if (raw.claude.strict !== undefined) {
      if (typeof raw.claude.strict !== "boolean") fail(where, '"claude.strict" must be true or false')
      claude.strict = raw.claude.strict
    }
    if (raw.claude.author !== undefined) {
      if (!isRecord(raw.claude.author)) fail(where, '"claude.author" must be an object with a name')
      onlyKeys(where, "claude.author.", raw.claude.author, ["name", "url"])
      claude.author = { name: nonEmptyString(where, "claude.author.name", raw.claude.author.name) }
      if (raw.claude.author.url !== undefined) claude.author.url = httpUrl(where, "claude.author.url", raw.claude.author.url)
    }
    if (raw.claude.license !== undefined) claude.license = nonEmptyString(where, "claude.license", raw.claude.license)
    if (raw.claude.homepage !== undefined) claude.homepage = httpUrl(where, "claude.homepage", raw.claude.homepage)
    if (raw.claude.repository !== undefined) claude.repository = httpUrl(where, "claude.repository", raw.claude.repository)
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

  const pi: Config["pi"] = { publish: false }
  if (raw.pi !== undefined) {
    if (!isRecord(raw.pi)) fail(where, '"pi" must be an object')
    onlyKeys(where, "pi.", raw.pi, ["publish"])
    if (raw.pi.publish !== undefined) {
      if (typeof raw.pi.publish !== "boolean") fail(where, '"pi.publish" must be true or false')
      pi.publish = raw.pi.publish
    }
  }

  return {
    marketplace: { name, description, owner },
    harnesses,
    commonDirs,
    kinds,
    sharedDir,
    pluginKey,
    ompScope,
    piScope,
    piPrefix,
    generatedBy,
    claude,
    omp,
    pi,
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
