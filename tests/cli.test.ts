import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanup, fixtureCopy, runCli, script, tempDir } from "./helpers"

let root: string
beforeEach(() => {
  root = fixtureCopy()
})
afterEach(cleanup)

const run = (...args: string[]) => runCli([...args, "--root", root])
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))

describe("build", () => {
  test("--check exits 1 and names the stale files before a build, 0 after", () => {
    const before = run("build", "--check")
    expect(before.code).toBe(1)
    expect(before.err).toContain(".claude-plugin/marketplace.json")
    expect(run("build").code).toBe(0)
    expect(run("build", "--check").code).toBe(0)
  })

  test("finds the root from a subdirectory by walking up to harness-kit.json", () => {
    expect(run("build").code).toBe(0)
    const nested = path.join(root, "plugins", "demo")
    const result = runCli(["build", "--check"], { cwd: nested })
    expect(result.code).toBe(0)
  })

  test("exits 2 with a clear message when there is no harness-kit.json", () => {
    const empty = tempDir()
    const result = runCli(["build", "--root", empty])
    expect(result.code).toBe(2)
    expect(result.err).toContain("harness-kit.json: not found")
  })

  test("exits 2 and names the field of an invalid config", () => {
    writeFileSync(path.join(root, "harness-kit.json"), JSON.stringify({ marketplace: { name: "x" } }))
    const result = run("build")
    expect(result.code).toBe(2)
    expect(result.err).toContain('"marketplace.description"')
  })
})

describe("stamp", () => {
  test("stamps the plugin and leaves the tree consistent", () => {
    expect(run("stamp", "demo", "3.1.4").code).toBe(0)
    expect(readJson("plugins/demo/package.json").version).toBe("3.1.4")
    expect(run("build", "--check").code).toBe(0)
  })

  test("rejects a bad version with exit 2", () => {
    expect(run("stamp", "demo", "bad").code).toBe(2)
  })

  test("needs both arguments", () => {
    const result = run("stamp", "demo")
    expect(result.code).toBe(2)
    expect(result.err).toContain("usage: harness-kit stamp")
  })

  test("--git-add stages the root-level generated files and no plugin files", () => {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString()
    git("init", "-q")
    expect(run("stamp", "demo", "3.1.4", "--git-add").code).toBe(0)
    const staged = git("diff", "--cached", "--name-only").trim().split("\n").sort()
    expect(staged).toEqual([".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json", "INVENTORY.md", "inventory.json"])
  })
})

describe("general", () => {
  test("an unknown command exits 2", () => {
    expect(run("frobnicate").code).toBe(2)
  })

  test("--version prints the package version", () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(runCli(["--version"]).out.trim()).toBe(manifest.version)
  })

  test("no command prints usage and exits 2; --help exits 0", () => {
    expect(runCli([]).code).toBe(2)
    expect(runCli(["--help"]).code).toBe(0)
    expect(runCli(["--help"]).out).toContain("usage: harness-kit")
  })
})

describe("validate-claude and check", () => {
  // A fake claude records its arguments and exits with the status in $FAKE_CLAUDE_STATUS.
  const installFakeClaude = () => {
    const bin = path.join(root, "node_modules", ".bin")
    mkdirSync(bin, { recursive: true })
    script(path.join(bin, "claude"), `echo "$@" >> "${path.join(root, "claude-calls.txt")}"\nexit "\${FAKE_CLAUDE_STATUS:-0}"`)
  }
  const calls = () => readFileSync(path.join(root, "claude-calls.txt"), "utf8").trim().split("\n")

  test("validates each Claude tree, then the marketplace, with --strict by default", () => {
    installFakeClaude()
    expect(run("validate-claude").code).toBe(0)
    expect(calls()).toEqual(["plugin validate --strict plugins/demo/claude", "plugin validate --strict ."])
  })

  test("--no-strict drops --strict", () => {
    installFakeClaude()
    expect(run("validate-claude", "--no-strict").code).toBe(0)
    expect(calls()[0]).toBe("plugin validate plugins/demo/claude")
  })

  test("claude.strict false in the config drops --strict", () => {
    installFakeClaude()
    const config = readJson("harness-kit.json")
    config.claude.strict = false
    writeFileSync(path.join(root, "harness-kit.json"), JSON.stringify(config))
    run("validate-claude")
    expect(calls()[0]).toBe("plugin validate plugins/demo/claude")
  })

  test("exits 1 when claude rejects a target, and stops at the first", () => {
    installFakeClaude()
    const result = runCli(["validate-claude", "--root", root], { env: { FAKE_CLAUDE_STATUS: "1" } })
    expect(result.code).toBe(1)
    expect(calls()).toHaveLength(1)
  })

  test("with no Claude plugins there is nothing to validate and claude is never run", () => {
    const empty = tempDir()
    writeFileSync(path.join(empty, "harness-kit.json"), readFileSync(path.join(root, "harness-kit.json")))
    const result = runCli(["validate-claude", "--root", empty])
    expect(result.code).toBe(0)
    expect(result.out).toContain("nothing to validate")
  })

  test("exits 2 when the claude executable is missing", () => {
    const result = runCli(["validate-claude", "--root", root], { env: { PATH: "/nonexistent" } })
    expect(result.code).toBe(2)
    expect(result.err).toContain("cannot run claude")
  })

  test("check fails on drift even when Claude validation passes", () => {
    installFakeClaude()
    expect(run("check").code).toBe(1)
    run("build")
    expect(run("check").code).toBe(0)
  })

  test("check fails when Claude validation fails on a current tree", () => {
    installFakeClaude()
    run("build")
    expect(runCli(["check", "--root", root], { env: { FAKE_CLAUDE_STATUS: "1" } }).code).toBe(1)
  })
})

describe("check: workflow tag against package pin", () => {
  const consumer = (ref: string) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { "@srobroek/harness-kit": "1.2.3" } }))
    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true })
    writeFileSync(
      path.join(root, ".github", "workflows", "ci.yml"),
      `jobs:\n  check:\n    uses: srobroek/harness-kit/.github/workflows/check.yml@${ref}\n`,
    )
    run("build")
    // No Claude CLI here; the warning is printed before validation is attempted.
    return runCli(["check", "--root", root], { env: { PATH: "/nonexistent" } })
  }

  test("warns, without failing the drift check, when the tag differs from the pin", () => {
    const result = consumer("v1.2.0")
    expect(result.err).toContain("ci.yml:3 uses harness-kit workflow @v1.2.0")
    expect(result.err).toContain("use @v1.2.3")
  })

  test("warns about a branch ref", () => {
    expect(consumer("main").err).toContain("@main")
  })

  test("is silent when the tag matches the pin", () => {
    expect(consumer("v1.2.3").err).not.toContain("warning:")
  })
})
