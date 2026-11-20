import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { findRoot, loadConfig, resolveConfig } from "../src/config"
import { cleanup, tempDir } from "./helpers"

afterEach(cleanup)

const minimal = { marketplace: { name: "m", description: "d", owner: { name: "o" } } }
const with_ = (extra: Record<string, unknown>) => ({ ...minimal, ...extra })

describe("resolveConfig defaults", () => {
  test("a minimal config enables all harnesses, skills and rules, eight kinds, and strict Claude validation", () => {
    expect(resolveConfig(minimal)).toEqual({
      marketplace: minimal.marketplace,
      harnesses: ["opencode", "claude", "omp"],
      commonDirs: ["skills", "rules"],
      kinds: ["skills", "agents", "commands", "rules", "hooks", "tools", "extensions", "mcp"],
      sharedDir: "shared",
      pluginKey: "agent-plugins",
      ompScope: "@agent-plugins",
      generatedBy: "harness-kit build",
      claude: { strict: true },
      omp: {},
    })
  })

  test("harnesses and kinds come back in canonical order whatever order the file lists them", () => {
    const config = resolveConfig(with_({ harnesses: ["omp", "opencode"], kinds: ["mcp", "skills"] }))
    expect(config.harnesses).toEqual(["opencode", "omp"])
    expect(config.kinds).toEqual(["skills", "mcp"])
  })
})

describe("resolveConfig errors", () => {
  test.each([
    ["a non-object", "x", /must be a JSON object/],
    ["a missing marketplace", {}, /missing "marketplace"/],
    ["a missing marketplace name", { marketplace: { description: "d", owner: { name: "o" } } }, /"marketplace.name"/],
    ["a missing marketplace description", { marketplace: { name: "m", owner: { name: "o" } } }, /"marketplace.description"/],
    ["a missing owner", { marketplace: { name: "m", description: "d" } }, /"marketplace.owner"/],
    ["an unknown top-level key", with_({ harnes: ["claude"] }), /unknown key "harnes"/],
    ["an unknown marketplace key", { marketplace: { ...minimal.marketplace, url: "x" } }, /"marketplace.url"/],
    ["an unknown harness", with_({ harnesses: ["codex"] }), /unknown harness "codex"/],
    ["no harnesses", with_({ harnesses: [] }), /"harnesses" must be a non-empty array/],
    ["a duplicate harness", with_({ harnesses: ["claude", "claude"] }), /lists a value twice/],
    ["an unknown kind", with_({ kinds: ["skills", "widgets"] }), /unknown kind "widgets"/],
    ["a commonDir with a path separator", with_({ commonDirs: ["a/b"] }), /plain directory name/],
    ["a sharedDir with a path separator", with_({ sharedDir: "a/b" }), /"sharedDir" must be a plain directory name/],
    ["a sharedDir that is plugins", with_({ sharedDir: "plugins" }), /"sharedDir" cannot be/],
    ["a sharedDir that is a commonDir", with_({ sharedDir: "rules" }), /"sharedDir" cannot be/],
    ["a duplicate commonDir", with_({ commonDirs: ["skills", "skills"] }), /twice/],
    ["an ompScope without @", with_({ ompScope: "mine" }), /"ompScope"/],
    ["a non-boolean claude.strict", with_({ claude: { strict: "yes" } }), /"claude.strict"/],
    ["an unknown claude key", with_({ claude: { lenient: true } }), /"claude.lenient"/],
    ["a claude.author without a name", with_({ claude: { author: {} } }), /"claude.author.name"/],
    ["an unknown claude.author key", with_({ claude: { author: { name: "o", email: "x" } } }), /"claude.author.email"/],
    ["a claude.homepage that is not a URL", with_({ claude: { homepage: "example" } }), /"claude.homepage"/],
    ["a claude.repository with a non-http scheme", with_({ claude: { repository: "ftp://example.com/r" } }), /"claude.repository"/],
    ["a claude.author.url that is not a URL", with_({ claude: { author: { name: "o", url: "x" } } }), /"claude.author.url"/],
    ["an invalid omp.packageType", with_({ omp: { packageType: "esm" } }), /"omp.packageType"/],
  ])("rejects %s", (_label, raw, message) => {
    expect(() => resolveConfig(raw)).toThrow(message)
  })

  test("names the file in every error", () => {
    expect(() => resolveConfig({}, "my.json")).toThrow(/^my\.json: /)
  })
})

describe("claude link defaults", () => {
  test("homepage, repository and author.url are kept", () => {
    const claude = resolveConfig(with_({ claude: { homepage: "https://e.com", repository: "https://github.com/o/r", author: { name: "o", url: "https://e.com/o" } } })).claude
    expect(claude).toEqual({ strict: true, homepage: "https://e.com", repository: "https://github.com/o/r", author: { name: "o", url: "https://e.com/o" } })
  })
})

describe("loadConfig and findRoot", () => {
  test("loadConfig reports a missing file and invalid JSON", () => {
    const dir = tempDir()
    expect(() => loadConfig(dir)).toThrow(/harness-kit.json: not found/)
    writeFileSync(path.join(dir, "harness-kit.json"), "{ nope")
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/)
  })

  test("findRoot returns the nearest ancestor with a harness-kit.json, or undefined", () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "harness-kit.json"), JSON.stringify(minimal))
    expect(findRoot(path.join(dir, "a", "b"))).toBe(dir)
    expect(findRoot(tempDir())).toBeUndefined()
  })
})
