#!/usr/bin/env bun
// harness-kit: generate and check the files derived from plugins/<name>/, stamp release versions, validate Claude and pi plugins.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { CONFIG_FILE, type Config, findRoot, loadConfig } from "./config"
import { drift, readPlugins, render, stampVersion, write } from "./generate"
import { update } from "./update"
import { workflowRefWarnings } from "./workflow-refs"
import { validateClaude } from "./validate-claude"
import { validatePi } from "./validate-pi"

const USAGE = `usage: harness-kit <command> [options]

commands:
  build [--check]               write every generated file; --check fails when one is stale
  stamp <plugin> <semver>       set a plugin's version, then regenerate (--git-add stages the root-level files)
  update [--check]              move the pinned @srobroek/harness-kit to the newest release and rebuild;
                                --check only reports (exit 1 when outdated). Never commits.
  validate-claude [--no-strict] run \`claude plugin validate\` on every Claude plugin and the marketplace
  validate-pi                   check every pi package without running pi: manifest paths, skills, extension syntax,
                                agent front matter
  check                         build --check, then validate-claude and validate-pi; warns when a workflow tag and the
                                package pin differ

options:
  --root <dir>   repository root (default: nearest directory at or above the cwd with ${CONFIG_FILE})
  --version      print the harness-kit version
  --help         print this text`

const plural = (count: number) => `${count} plugin${count === 1 ? "" : "s"}`

function resolveRoot(explicit: string | undefined): string {
  if (explicit !== undefined) return path.resolve(explicit)
  const found = findRoot(process.cwd())
  if (!found) throw new Error(`no ${CONFIG_FILE} at or above ${process.cwd()}; run from the repository or pass --root`)
  return found
}

/** 0 when current, 1 when a generated file is stale. */
function buildCheck(root: string, config: Config): number {
  const plugins = readPlugins(root, config)
  const { changed, extra } = drift(root, render(root, plugins, config), config)
  const stale = [...changed, ...extra]
  if (stale.length > 0) {
    console.error("Generated files are stale. Run `harness-kit build` and commit the result:")
    for (const file of stale) console.error(`  ${path.relative(root, file)}`)
    return 1
  }
  console.log(`generated files are current (${plural(plugins.length)})`)
  return 0
}

function buildWrite(root: string, config: Config): number {
  const plugins = readPlugins(root, config)
  const outputs = render(root, plugins, config)
  write(root, outputs, config)
  console.log(`generated ${outputs.length} files for ${plural(plugins.length)}`)
  return 0
}

/** Stage the generated files that live outside plugins/, which semantic-release's git assets cannot reach. */
function gitAddRootFiles(root: string, config: Config): void {
  const files = render(root, readPlugins(root, config), config)
    .map((output) => path.relative(root, output.file))
    .filter((file) => !file.startsWith(`plugins${path.sep}`) && existsSync(path.join(root, file)))
  if (files.length > 0) execFileSync("git", ["add", "--", ...files], { cwd: root, stdio: "inherit" })
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }
  return manifest.version
}

/** Exit status: 0 success, 1 stale files or a rejected Claude or pi plugin, 2 usage or configuration error. */
export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        root: { type: "string" },
        check: { type: "boolean" },
        strict: { type: "boolean" },
        "git-add": { type: "boolean" },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
    const [command, ...rest] = positionals
    if (values.version) {
      console.log(packageVersion())
      return 0
    }
    if (values.help || !command) {
      console.log(USAGE)
      return values.help ? 0 : 2
    }
    const known = ["build", "stamp", "update", "validate-claude", "validate-pi", "check"]
    if (!known.includes(command)) throw new Error(`unknown command "${command}" (use ${known.join(", ")})\n${USAGE}`)
    if (command !== "stamp" && rest.length > 0) throw new Error(`${command} takes no arguments, got "${rest.join(" ")}"`)

    const root = resolveRoot(values.root)
    if (command === "update") {
      const result = update(root, { check: values.check })
      console.log(result.status === "current" ? "up to date" : `${result.from} -> ${result.to}`)
      return result.status === "outdated" ? 1 : 0
    }
    const config = loadConfig(root)
    switch (command) {
      case "build":
        return values.check ? buildCheck(root, config) : buildWrite(root, config)
      case "stamp": {
        const [plugin, version] = rest
        if (!plugin || !version || rest.length > 2) throw new Error("usage: harness-kit stamp <plugin> <semver>")
        stampVersion(root, plugin, version, config)
        if (values["git-add"]) gitAddRootFiles(root, config)
        console.log(`stamped ${plugin} ${version}`)
        return 0
      }
      case "validate-claude":
        return validateClaude(root, config, { strict: values.strict === false ? false : undefined })
      case "validate-pi":
        return validatePi(root, config)
      default: {
        for (const warning of workflowRefWarnings(root)) console.warn(`warning: ${warning}`)
        const built = buildCheck(root, config)
        const validated = validateClaude(root, config, { strict: values.strict === false ? false : undefined })
        const piValid = validatePi(root, config)
        return built || validated || piValid
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
