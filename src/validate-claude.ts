// Runs `claude plugin validate` on every Claude plugin tree and then on the marketplace.

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import type { Config } from "./config"

export type ValidateOptions = {
  /** Overrides claude.strict from harness-kit.json. */
  strict?: boolean
  /** The claude executable. Defaults to node_modules/.bin/claude under the root, then `claude` on PATH. */
  claudeBin?: string
}

function claudeBinary(root: string): string {
  const local = path.join(root, "node_modules", ".bin", "claude")
  return existsSync(local) ? local : "claude"
}

/** Claude plugin trees, as paths relative to the root. */
function claudeTrees(root: string): string[] {
  const plugins = path.join(root, "plugins")
  if (!existsSync(plugins)) return []
  return readdirSync(plugins, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(plugins, entry.name, "claude")))
    .map((entry) => path.join("plugins", entry.name, "claude"))
    .sort()
}

/** Exit status: 0 when everything validates (or there is nothing to validate), 1 when the CLI rejects a target. */
export function validateClaude(root: string, config: Config, options: ValidateOptions = {}): number {
  if (!config.harnesses.includes("claude")) {
    console.log("claude is not enabled in harness-kit.json; nothing to validate")
    return 0
  }
  const trees = claudeTrees(root)
  // An empty marketplace makes the CLI warn, and --strict turns that into a failure, so skip it.
  if (trees.length === 0) {
    console.log("no Claude plugins yet; nothing to validate")
    return 0
  }
  const strict = options.strict ?? config.claude.strict
  const bin = options.claudeBin ?? claudeBinary(root)
  for (const target of [...trees, "."]) {
    console.log(`claude plugin validate${strict ? " --strict" : ""} ${target}`)
    const run = spawnSync(bin, ["plugin", "validate", ...(strict ? ["--strict"] : []), target], { cwd: root, stdio: "inherit" })
    if (run.error) {
      throw new Error(`cannot run ${bin}: ${run.error.message} (install @anthropic-ai/claude-code as a devDependency)`)
    }
    if (run.status !== 0) return 1
  }
  return 0
}
