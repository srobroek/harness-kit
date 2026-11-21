// `harness-kit update`: move the pinned @srobroek/harness-kit to the newest published version and regenerate.
// It reads the lockfile to pick bun or npm. It never commits or pushes; the CI job that calls it does that.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { type DependencyField, detectPackageManager, latestVersionCommand, pinCommand } from "./package-manager"
import { fail, isRecord } from "./util"

export const PACKAGE_NAME = "@srobroek/harness-kit"
const DEPENDENCY_FIELDS: readonly DependencyField[] = ["dependencies", "devDependencies", "optionalDependencies"]

/** Run a command in `cwd`. `capture` returns its stdout; otherwise it inherits the terminal. Throws on a non-zero exit. */
export type Exec = (command: string, args: string[], options: { cwd: string; capture?: boolean }) => string

export const defaultExec: Exec = (command, args, { cwd, capture }) => {
  const run = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" })
  if (run.error) throw new Error(`cannot run ${command}: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${run.status}`)
  return run.stdout ?? ""
}

export type UpdateResult = { status: "current" | "outdated" | "updated"; from: string; to: string }

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/** Negative when a < b, 0 when equal, positive when a > b. A prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [VERSION.exec(a), VERSION.exec(b)]
  if (!pa || !pb) throw new Error(`cannot compare versions "${a}" and "${b}"`)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) return diff
  }
  if (pa[4] === pb[4]) return 0
  if (pa[4] === undefined) return 1
  if (pb[4] === undefined) return -1
  return pa[4] < pb[4] ? -1 : 1
}

/** The dependency field that lists the package, and its pinned version. */
function pin(root: string): { field: DependencyField; version: string } {
  const file = path.join(root, "package.json")
  if (!existsSync(file)) fail("package.json", `not found in ${root}`)
  const manifest: unknown = JSON.parse(readFileSync(file, "utf8"))
  for (const field of DEPENDENCY_FIELDS) {
    const section = isRecord(manifest) ? manifest[field] : undefined
    const spec = isRecord(section) ? section[PACKAGE_NAME] : undefined
    if (typeof spec === "string") {
      const version = spec.replace(/^[\^~=v]+/, "")
      if (!VERSION.test(version)) fail("package.json", `${field}["${PACKAGE_NAME}"] is "${spec}", which is not a plain version`)
      return { field, version }
    }
  }
  return fail("package.json", `${PACKAGE_NAME} is not in dependencies, devDependencies or optionalDependencies`)
}

/** The pinned version of the package in the first dependency field that lists it. */
export function pinnedVersion(root: string): string {
  return pin(root).version
}

export function update(root: string, options: { check?: boolean; exec?: Exec } = {}): UpdateResult {
  const exec = options.exec ?? defaultExec
  const { field, version: from } = pin(root)
  const manager = detectPackageManager(root)
  const latest = latestVersionCommand(manager, PACKAGE_NAME)
  const to = exec(latest.command, latest.args, { cwd: root, capture: true }).trim()
  if (!VERSION.test(to)) throw new Error(`${latest.command} ${latest.args[0]} returned "${to}", expected a version`)
  if (compareVersions(to, from) <= 0) return { status: "current", from, to: from }
  if (options.check) return { status: "outdated", from, to }
  const add = pinCommand(manager, field, PACKAGE_NAME, to)
  exec(add.command, add.args, { cwd: root })
  // The new release regenerates, not the copy that is running.
  exec(path.join(root, "node_modules", ".bin", "harness-kit"), ["build", "--root", root], { cwd: root })
  return { status: "updated", from, to }
}
