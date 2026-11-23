import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import prereqsExtension, { installedPackages, missingRequired, prereqMessage } from "../runtime/pi/prereqs.ts"
import { type Config, loadConfig, readCompanions } from "../src/config"
import { drift, readPlugins, render, write } from "../src/generate"
import { prerequisiteProblems, validatePi } from "../src/validate-pi"
import { cleanup, fakePi, fixtureCopy, tempDir } from "./helpers"

afterEach(cleanup)

const QUALITY = { package: "@srobroek/pi-code-quality", for: "the quality skills the prompts refer to", required: true }
const TOOLCHAIN = { package: "pi-toolchain", for: "toolchain skills", range: "^2.0.0" }

const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

describe("companions in the plugin settings", () => {
  const read = (raw: unknown) => readCompanions("plugins/demo/package.json", "agent-plugins.companions", raw)

  test("required defaults to false, a range is kept, and keys come back in one order", () => {
    expect(read([{ for: "x", package: "pi-toolchain", range: "^2.0.0" }, QUALITY])).toEqual([
      { package: "pi-toolchain", for: "x", required: false, range: "^2.0.0" },
      QUALITY,
    ])
    expect(read(undefined)).toBeUndefined()
  })

  test.each([
    ["a non-list", "x", /"agent-plugins\.companions" must be a non-empty list/],
    ["an empty list", [], /"agent-plugins\.companions" must be a non-empty list/],
    ["an entry that is not an object", ["pi-x"], /"agent-plugins\.companions\[0\]" must be an object/],
    ["a missing package", [{ for: "x" }], /"agent-plugins\.companions\[0\]\.package" must be a non-empty string/],
    ["a package with capitals", [{ package: "Pi-X", for: "x" }], /"agent-plugins\.companions\[0\]\.package" must be an npm package name/],
    ["a package with a path", [{ package: "@a/b/c", for: "x" }], /must be an npm package name/],
    ["a missing for", [{ package: "pi-x" }], /"agent-plugins\.companions\[0\]\.for" must be a non-empty string/],
    ["a for over two lines", [{ package: "pi-x", for: "a\nb" }], /"agent-plugins\.companions\[0\]\.for" must be one line/],
    ["a required that is not a boolean", [{ package: "pi-x", for: "x", required: 1 }], /"agent-plugins\.companions\[0\]\.required" must be true or false/],
    ["a range that is not supported", [{ package: "pi-x", for: "x", range: "latest" }], /"agent-plugins\.companions\[0\]\.range": "latest" is not a supported semver range/],
    ["an unknown key", [{ package: "pi-x", for: "x", optional: true }], /unknown key "agent-plugins\.companions\[0\]\.optional"/],
    ["a package listed twice", [QUALITY, QUALITY], /lists "@srobroek\/pi-code-quality" twice/],
  ])("rejects %s, naming the file and the field", (_label, raw, message) => {
    expect(() => read(raw)).toThrow(message)
    expect(() => read(raw)).toThrow(/^plugins\/demo\/package\.json: /)
  })
})

describe("the companion check", () => {
  /** A package tree with its list, an agent directory and a project, none of which pi has touched. */
  const setup = (companions: unknown[], prerequisites: unknown[] = []) => {
    const root = tempDir()
    put(path.join(root, "_kit", "prereqs.json"), JSON.stringify({ plugin: "demo", prerequisites, companions }))
    const agent = tempDir()
    const project = tempDir()
    const deps = { root, cwd: project, env: { PATH: tempDir(), PI_CODING_AGENT_DIR: agent, HOME: tempDir() } }
    return { root, agent, project, deps }
  }
  const settings = (dir: string, packages: unknown[]) => put(path.join(dir, "settings.json"), JSON.stringify({ packages }))

  test("a companion that no settings file installs is named in the notice with its install command, next to the missing tools", () => {
    const tool = { bin: "frobnicate-cli", for: "frobnicating", required: false, install: { url: "https://example.com/frob" } }
    const { deps } = setup([QUALITY, { ...TOOLCHAIN, required: false }], [tool])
    const pi = fakePi()
    const notices: string[] = []
    prereqsExtension(pi.api, deps)
    pi.emit("session_start", { reason: "startup" }, { hasUI: true, cwd: deps.cwd, ui: { notify: (message: string) => void notices.push(message) } })
    expect(notices).toEqual([
      [
        "demo: prerequisites not met:",
        "- frobnicate-cli (for frobnicating): not on PATH; install: see https://example.com/frob",
        "- @srobroek/pi-code-quality (required, for the quality skills the prompts refer to): not installed; install: pi install npm:@srobroek/pi-code-quality",
        "- pi-toolchain (for toolchain skills): not installed; install: pi install npm:pi-toolchain",
      ].join("\n"),
    ])
  })

  test("npm entries in the agent directory's settings, with or without a version, count as installed", () => {
    const { agent, deps } = setup([QUALITY, { ...TOOLCHAIN, required: false }])
    settings(agent, ["npm:@srobroek/pi-code-quality@1.4.0", { source: "npm:pi-toolchain" }, "git:github.com/o/other@v1"])
    expect(missingRequired(deps)).toEqual([])
    const lines: string[] = []
    const pi = fakePi()
    prereqsExtension(pi.api, { ...deps, stderr: (line) => void lines.push(line) })
    pi.emit("session_start", {}, { hasUI: false, cwd: deps.cwd })
    expect(lines).toEqual([])
  })

  test("the project's .pi/settings.json counts, and a local path entry counts by its package.json name", () => {
    const { project, deps } = setup([QUALITY, { ...TOOLCHAIN, required: true }])
    put(path.join(project, "vendor", "quality", "package.json"), JSON.stringify({ name: "@srobroek/pi-code-quality" }))
    settings(path.join(project, ".pi"), ["../vendor/quality"])
    expect(missingRequired(deps)).toEqual(["pi-toolchain"])
    expect(prereqMessage("pi-toolchain", deps)).toBe("demo needs pi-toolchain (required, for toolchain skills): not installed; install: pi install npm:pi-toolchain")
    expect(prereqMessage("@srobroek/pi-code-quality", deps)).toBe("demo: @srobroek/pi-code-quality is available")
  })

  test("missingRequired lists required companions after required tools, and leaves out optional ones", () => {
    const gate = { bin: "gatekeeper", for: "the gate", required: true, install: { url: "https://e.com/g" } }
    const { deps } = setup([QUALITY, { ...TOOLCHAIN, required: false }], [gate])
    expect(missingRequired(deps)).toEqual(["gatekeeper", "@srobroek/pi-code-quality"])
  })

  test("an unreadable settings file installs nothing", () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "settings.json"), "{ nope")
    expect(installedPackages(path.join(dir, "settings.json"), {})).toEqual([])
    expect(installedPackages(path.join(dir, "missing.json"), {})).toEqual([])
  })
})

describe("generated companions", () => {
  let root: string
  let config: Config
  const demo = (file: string) => path.join(root, "plugins", "demo", file)
  const readJson = (file: string) => JSON.parse(readFileSync(demo(file), "utf8"))
  const editOwn = (change: (own: any) => void) => {
    const manifest = JSON.parse(readFileSync(demo("package.json"), "utf8"))
    change(manifest["agent-plugins"])
    writeFileSync(demo("package.json"), JSON.stringify(manifest))
  }
  const generate = () => write(root, render(root, readPlugins(root, config), config), config)
  const stale = () => {
    const found = drift(root, render(root, readPlugins(root, config), config), config)
    return [...found.changed, ...found.extra].map((file) => path.relative(root, file)).sort()
  }
  const WORKS_WITH = [
    "## Works with",
    "",
    "This package works with these pi packages. Install them next to it.",
    "",
    "| Package | Required | For | Install |",
    "| --- | --- | --- | --- |",
    "| `@srobroek/pi-code-quality` | yes | the quality skills the prompts refer to | `pi install npm:@srobroek/pi-code-quality` |",
    "| `pi-toolchain` | no | toolchain skills | `pi install npm:pi-toolchain` |",
    "",
  ].join("\n")

  beforeEach(() => {
    root = fixtureCopy()
    config = loadConfig(root)
    editOwn((own) => {
      own.harnesses.push("pi")
      own.companions = [QUALITY, TOOLCHAIN]
    })
  })

  test("the pi tree gets the check with the companions, and the OMP tree, without prerequisites, gets nothing", () => {
    generate()
    expect(readJson("pi/_kit/prereqs.json")).toEqual({ plugin: "demo", prerequisites: [], companions: [QUALITY, { ...TOOLCHAIN, required: false }] })
    expect(readJson("pi/package.json").pi.extensions).toEqual(["./_kit/rules.ts", "./_kit/prereqs.ts"])
    expect(existsSync(demo("omp/_kit"))).toBe(false)
    expect(validatePi(root, config)).toBe(0)
    expect(stale()).toEqual([])
  })

  test("with prerequisites too, the OMP tree's list has no companions: OMP installs no pi packages", () => {
    editOwn((own) => (own.prerequisites = [{ bin: "bd", for: "beads", install: { url: "https://e.com/bd" } }]))
    generate()
    expect(readJson("omp/_kit/prereqs.json")).not.toHaveProperty("companions")
    expect(readJson("pi/_kit/prereqs.json").companions).toHaveLength(2)
  })

  test("the pi README gets a Works with section after the plugin's own README", () => {
    put(demo("README.md"), "# demo\n\nThe demo plugin.\n\n\n")
    generate()
    expect(readFileSync(demo("pi/README.md"), "utf8")).toBe(`# demo\n\nThe demo plugin.\n\n${WORKS_WITH}`)
    put(demo("README.md"), "# demo\n\nChanged.\n")
    expect(stale()).toEqual(["plugins/demo/pi/README.md"])
  })

  test("a plugin without a README gets a heading and its description in front of the section", () => {
    generate()
    expect(readFileSync(demo("pi/README.md"), "utf8")).toBe(`# @agent-plugins/demo\n\nFixture plugin for the generator tests.\n\n${WORKS_WITH}`)
  })

  test("with pi.publish on, the companions are optional peers at their range, or *", () => {
    config = { ...config, pi: { publish: true } }
    put(path.join(root, "package.json"), JSON.stringify({ license: "Apache-2.0", repository: "srobroek/harness-plugins" }))
    put(demo("pi/extensions/gate.ts"), 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"\nexport default function (pi: ExtensionAPI) {}\n')
    generate()
    const manifest = readJson("pi/package.json")
    expect(manifest.peerDependencies).toEqual({ "@earendil-works/pi-coding-agent": "*", "@srobroek/pi-code-quality": "*", "pi-toolchain": "^2.0.0" })
    expect(Object.keys(manifest.peerDependencies)).toEqual(["@earendil-works/pi-coding-agent", "@srobroek/pi-code-quality", "pi-toolchain"])
    expect(manifest.peerDependenciesMeta).toEqual({ "@srobroek/pi-code-quality": { optional: true }, "pi-toolchain": { optional: true } })
    expect(manifest).not.toHaveProperty("dependencies")
    expect(manifest.files).toContain("README.md")
    expect(stale()).toEqual([])
  })

  test("with pi.publish off, the package.json carries no peers for the companions", () => {
    generate()
    expect(readJson("pi/package.json")).not.toHaveProperty("peerDependencies")
    expect(readJson("pi/package.json")).not.toHaveProperty("peerDependenciesMeta")
  })

  test.each([
    ["a package pi supplies", [{ package: "@earendil-works/pi-tui", for: "x" }], /companion "@earendil-works\/pi-tui" is supplied by pi itself/],
    ["the plugin's own pi package", [{ package: "@agent-plugins/demo", for: "x" }], /companion "@agent-plugins\/demo" is this plugin's own pi package/],
  ])("refuses %s", (_label, companions, message) => {
    editOwn((own) => (own.companions = companions))
    expect(() => readPlugins(root, config)).toThrow(message)
  })

  test("validate-pi reports a list that differs from the companions", () => {
    generate()
    writeFileSync(demo("pi/_kit/prereqs.json"), JSON.stringify({ plugin: "demo", prerequisites: [] }))
    expect(prerequisiteProblems(demo("pi"), readPlugins(root, config)[0] as never)).toEqual([
      '_kit/prereqs.json: does not match "prerequisites" and "companions" in plugins/demo/package.json; run harness-kit build',
    ])
  })

  test("dropping the companions removes the check; the README stays until removed by hand, as when publishing stops", () => {
    generate()
    editOwn((own) => delete own.companions)
    generate()
    expect(existsSync(demo("pi/_kit/prereqs.ts"))).toBe(false)
    expect(readJson("pi/package.json").pi.extensions).toEqual(["./_kit/rules.ts"])
    expect(existsSync(demo("pi/README.md"))).toBe(true)
    rmSync(demo("pi/README.md"))
    expect(stale()).toEqual([])
  })
})
