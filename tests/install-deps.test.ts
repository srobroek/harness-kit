import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanup, script, tempDir } from "./helpers"

afterEach(cleanup)

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "install-deps.sh")
const ROOT = path.join(import.meta.dir, "..")

/** A repo with the given lockfiles, and a PATH whose bun and npm only record their arguments (and fail when asked to). */
function run(lockfiles: string[], failing?: "bun" | "npm") {
  const repo = tempDir()
  for (const lockfile of lockfiles) writeFileSync(path.join(repo, lockfile), "")
  const bin = tempDir()
  const log = path.join(bin, "calls.log")
  for (const tool of ["bun", "npm"]) {
    script(path.join(bin, tool), `echo "${tool} $*" >> "${log}"\n${failing === tool ? "exit 7" : "exit 0"}`)
  }
  const result = Bun.spawnSync(["sh", SCRIPT], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" })
  let calls: string[] = []
  try {
    calls = readFileSync(log, "utf8").trim().split("\n")
  } catch {}
  return { code: result.exitCode, calls }
}

describe("scripts/install-deps.sh", () => {
  test.each([
    ["npm only", ["package-lock.json"], "npm ci"],
    ["bun.lock only", ["bun.lock"], "bun install --frozen-lockfile"],
    ["bun.lockb only", ["bun.lockb"], "bun install --frozen-lockfile"],
    ["both lockfiles", ["package-lock.json", "bun.lock"], "bun install --frozen-lockfile"],
    ["no lockfile", [], "npm ci"],
  ])("%s runs exactly: %s", (_name, lockfiles, command) => {
    expect(run(lockfiles)).toEqual({ code: 0, calls: [command] })
  })

  test.each([
    ["bun", ["bun.lock"]],
    ["npm", ["package-lock.json"]],
  ] as const)("a failed %s install fails the step", (tool, lockfiles) => {
    expect(run([...lockfiles], tool).code).toBe(7)
  })
})

// check.yml and the GitLab template are copied or called without this repo's scripts, so each embeds the script's body.
describe("the install dispatch has one source", () => {
  const body = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.trim())
    .join("\n")
  const squash = (file: string) => readFileSync(path.join(ROOT, file), "utf8").split("\n").map((line) => line.trim()).join("\n")

  test.each([".github/workflows/check.yml", "templates/gitlab-deps-bump.yml"])("%s embeds the script body", (file) => {
    expect(squash(file)).toContain(body)
  })
})
