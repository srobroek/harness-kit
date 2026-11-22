// Which package manager a consumer repo uses, read from its lockfile. bun is the default; a repo that
// still commits package-lock.json (and no bun lockfile) keeps working with npm during the migration.

import { existsSync } from "node:fs"
import path from "node:path"

export type PackageManager = "bun" | "npm"
export type DependencyField = "dependencies" | "devDependencies" | "optionalDependencies"

const BUN_LOCKFILES = ["bun.lock", "bun.lockb"]

/** bun when a bun lockfile exists, else npm when package-lock.json exists, else bun. */
export function detectPackageManager(root: string): PackageManager {
  if (BUN_LOCKFILES.some((file) => existsSync(path.join(root, file)))) return "bun"
  return existsSync(path.join(root, "package-lock.json")) ? "npm" : "bun"
}

type Command = { command: PackageManager; args: string[] }

/** The command that prints the newest published version of `name`. */
export function latestVersionCommand(manager: PackageManager, name: string): Command {
  return manager === "bun" ? { command: "bun", args: ["info", name, "version"] } : { command: "npm", args: ["view", name, "version"] }
}

/** The command that pins `name@version` exactly, in the dependency field that already lists it. */
export function pinCommand(manager: PackageManager, field: DependencyField, name: string, version: string): Command {
  const spec = `${name}@${version}`
  if (manager === "bun") {
    const flag = { dependencies: [], devDependencies: ["--dev"], optionalDependencies: ["--optional"] }[field]
    return { command: "bun", args: ["add", "--exact", ...flag, spec] }
  }
  const flag = { dependencies: [], devDependencies: ["--save-dev"], optionalDependencies: ["--save-optional"] }[field]
  return { command: "npm", args: ["install", "--save-exact", ...flag, spec] }
}
