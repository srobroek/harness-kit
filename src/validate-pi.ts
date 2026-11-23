// Static checks of every generated pi package: the problems `pi install` and pi-subagents would report, or would skip
// the resource for silently, found without running pi.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { Config } from "./config"
import { piPackageName, type Plugin, prerequisiteData, readPlugins } from "./generate"
import { PREREQS_DATA, PREREQS_MODULE, RUNTIME_DIR } from "./runtime"
import { isRecord } from "./util"

const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[^\S\r\n]*(?:\r?\n|$)/
const MODULE = /\.(?:[cm]?[jt]s)$/

/** pi package trees, as paths relative to the root. */
function piTrees(root: string): string[] {
  const plugins = path.join(root, "plugins")
  if (!existsSync(plugins)) return []
  return readdirSync(plugins, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(plugins, entry.name, "pi")))
    .map((entry) => path.join("plugins", entry.name, "pi"))
    .sort()
}

/** The parsed front matter of a Markdown file: a mapping, or a message saying why it is not one. */
function frontMatter(text: string): Record<string, unknown> | string {
  const match = FRONT_MATTER.exec(text)
  if (!match) return "has no front matter"
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(match[1] ?? "")
  } catch (error) {
    return `front matter is not valid YAML (${error instanceof Error ? error.message : String(error)})`
  }
  return isRecord(parsed) ? parsed : "front matter is not a mapping"
}

const nonEmpty = (value: unknown) => typeof value === "string" && value.trim() !== ""

/** Markdown files under dir, recursively, as paths relative to it. */
function markdownFiles(dir: string, prefix = ""): string[] {
  return readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return markdownFiles(dir, relative)
    return entry.name.endsWith(".md") ? [relative] : []
  })
}

function extensionProblems(file: string, shown: string): string[] {
  if (!statSync(file).isFile() || !MODULE.test(file)) return [`${shown}: an extension must be a .ts or .js file`]
  const loader = /\.[cm]?ts$/.test(file) ? "ts" : "js"
  let exports: string[]
  try {
    exports = new Bun.Transpiler({ loader }).scan(readFileSync(file, "utf8")).exports
  } catch (error) {
    return [`${shown}: does not parse (${error instanceof Error ? error.message : String(error)})`]
  }
  return exports.includes("default") ? [] : [`${shown}: has no default export; pi calls the default export with its API`]
}

/** A skills root holds skill directories, or is one; each skill needs a SKILL.md with a description. */
function skillProblems(dir: string, shown: string): string[] {
  if (!statSync(dir).isDirectory()) return [`${shown}: must be a directory of skills`]
  const skills = existsSync(path.join(dir, "SKILL.md"))
    ? [""]
    : readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
  return skills.flatMap((skill) => {
    const where = skill ? `${shown}/${skill}` : shown
    const file = path.join(dir, skill, "SKILL.md")
    if (!existsSync(file)) return [`${where}: has no SKILL.md`]
    const front = frontMatter(readFileSync(file, "utf8"))
    if (typeof front === "string") return [`${where}/SKILL.md: ${front}`]
    return nonEmpty(front.description) ? [] : [`${where}/SKILL.md: needs a description, or pi does not load the skill`]
  })
}

/** Each agent file (chains excepted) needs front matter with a name and a description, or pi-subagents skips it. */
function agentProblems(dir: string, shown: string): string[] {
  if (!statSync(dir).isDirectory()) return [`${shown}: must be a directory of agents`]
  return markdownFiles(dir)
    .filter((file) => !file.endsWith(".chain.md"))
    .sort()
    .flatMap((file) => {
      const front = frontMatter(readFileSync(path.join(dir, file), "utf8"))
      if (typeof front === "string") return [`${shown}/${file}: ${front}`]
      const missing = ["name", "description"].filter((key) => !nonEmpty(front[key]))
      return missing.length > 0 ? [`${shown}/${file}: needs ${missing.join(" and ")}, or pi-subagents skips the agent`] : []
    })
}

const CHECKS: Record<string, (target: string, shown: string) => string[]> = {
  extensions: extensionProblems,
  skills: skillProblems,
  prompts: () => [],
  "subagents.agents": agentProblems,
}

/** Problems in one pi package directory, each as `<path relative to it>: <message>`. Empty when it is valid. */
export function piPackageProblems(dir: string): string[] {
  const file = path.join(dir, "package.json")
  if (!existsSync(file)) return ["package.json: missing"]
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    return [`package.json: not valid JSON (${error instanceof Error ? error.message : String(error)})`]
  }
  if (!isRecord(manifest)) return ["package.json: must be a JSON object"]
  const problems: string[] = []
  for (const key of ["name", "version"]) if (!nonEmpty(manifest[key])) problems.push(`package.json: "${key}" must be a non-empty string`)
  if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes("pi-package")) problems.push('package.json: "keywords" must include "pi-package"')
  const pi = manifest.pi
  if (!isRecord(pi)) return [...problems, 'package.json: "pi" must be an object']
  const lists: Record<string, unknown> = {
    extensions: pi.extensions,
    skills: pi.skills,
    prompts: pi.prompts,
    "subagents.agents": isRecord(pi.subagents) ? pi.subagents.agents : pi.subagents,
  }
  for (const [field, value] of Object.entries(lists)) {
    if (value === undefined) continue
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      problems.push(`package.json: "pi.${field}" must be a list of paths`)
      continue
    }
    for (const entry of value as string[]) {
      const target = path.resolve(dir, entry)
      const shown = path.relative(dir, target).split(path.sep).join("/")
      if (shown.startsWith("..") || path.isAbsolute(shown)) problems.push(`package.json: "pi.${field}" entry ${JSON.stringify(entry)} is outside the package`)
      else if (!existsSync(target)) problems.push(`package.json: "pi.${field}" entry ${JSON.stringify(entry)} does not exist`)
      else problems.push(...(CHECKS[field] as (target: string, shown: string) => string[])(target, shown))
    }
  }
  return problems
}

/** A package's parsed manifest, or undefined when it cannot be read (`piPackageProblems` reports that). */
function readManifest(dir: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    return isRecord(manifest) ? manifest : undefined
  } catch {
    return undefined
  }
}

/** The `pi.extensions` list of a package, or undefined when its manifest cannot be read. */
function listedExtensions(dir: string): unknown[] | undefined {
  const pi = readManifest(dir)?.pi
  if (!isRecord(pi)) return undefined
  return Array.isArray(pi.extensions) ? pi.extensions : []
}

/** A pi package's `name` must be the one the plugin's settings give, `piPackageName`. */
export function piNameProblems(dir: string, plugin: Pick<Plugin, "name" | "piName">, config: Pick<Config, "piScope" | "piPrefix">): string[] {
  const name = readManifest(dir)?.name
  const expected = piPackageName(plugin, config)
  if (typeof name !== "string" || name === "" || name === expected) return []
  return [`package.json: "name" is ${JSON.stringify(name)}, but the plugin's pi package is "${expected}" ("piScope", then "piName" or "piPrefix" and the plugin name); run harness-kit build`]
}

/**
 * Problems with the prerequisite check of one pi package, against the plugin's `prerequisites`: a declaring plugin needs
 * `_kit/prereqs.ts`, listed as an extension, and a `_kit/prereqs.json` equal to its list; a plugin without them, neither file.
 */
export function prerequisiteProblems(dir: string, plugin: Pick<Plugin, "name" | "prerequisites">): string[] {
  const module = `${RUNTIME_DIR}/${PREREQS_MODULE}`
  const data = `${RUNTIME_DIR}/${PREREQS_DATA}`
  const present = (file: string) => existsSync(path.join(dir, file))
  if (!plugin.prerequisites) return [module, data].filter(present).map((file) => `${file}: the plugin declares no prerequisites; run harness-kit build to remove it`)
  const problems: string[] = []
  if (!present(module)) problems.push(`${module}: missing, but the plugin declares prerequisites; run harness-kit build`)
  const extensions = listedExtensions(dir)
  if (extensions && !extensions.includes(`./${module}`)) problems.push(`package.json: "pi.extensions" must list "./${module}", or pi does not run the prerequisite check`)
  if (!present(data)) return [...problems, `${data}: missing, but the plugin declares prerequisites; run harness-kit build`]
  let listed: unknown
  try {
    listed = JSON.parse(readFileSync(path.join(dir, data), "utf8"))
  } catch (error) {
    return [...problems, `${data}: not valid JSON (${error instanceof Error ? error.message : String(error)})`]
  }
  if (!isDeepStrictEqual(listed, prerequisiteData(plugin))) problems.push(`${data}: does not match "prerequisites" in plugins/${plugin.name}/package.json; run harness-kit build`)
  return problems
}

/** Exit status: 0 when every pi package passes (or there is none), 1 when one has a problem. */
export function validatePi(root: string, config: Config): number {
  if (!config.harnesses.includes("pi")) {
    console.log("pi is not enabled in harness-kit.json; nothing to validate")
    return 0
  }
  const trees = piTrees(root)
  if (trees.length === 0) {
    console.log("no pi packages yet; nothing to validate")
    return 0
  }
  const plugins = new Map(readPlugins(root, config).map((plugin) => [plugin.name, plugin]))
  const problems = trees.flatMap((tree) => {
    const dir = path.join(root, tree)
    const plugin = plugins.get(path.basename(path.dirname(tree)))
    const found = [...piPackageProblems(dir), ...(plugin ? [...piNameProblems(dir, plugin, config), ...prerequisiteProblems(dir, plugin)] : [])]
    return found.map((problem) => `${tree.split(path.sep).join("/")}/${problem}`)
  })
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) return 1
  console.log(`pi packages are valid (${trees.length} plugin${trees.length === 1 ? "" : "s"})`)
  return 0
}
