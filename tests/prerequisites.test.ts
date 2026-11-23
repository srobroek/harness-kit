import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import prereqsExtension, { missingRequired, parseRange, prereqMessage, satisfies, versionIn } from "../runtime/pi/prereqs.ts"
import { type Config, loadConfig, readPrerequisites } from "../src/config"
import { drift, readPlugins, render, write } from "../src/generate"
import { prerequisiteProblems, validatePi } from "../src/validate-pi"
import { cleanup, fakePi, fixtureCopy, script, tempDir } from "./helpers"

afterEach(cleanup)

const BD = { bin: "bd", for: "Beads gates and skills", required: true, install: { mise: "aqua:gastownhall/beads", url: "https://github.com/steveyegge/beads#install" }, version: ">=1.3.0" }
const FROB = { bin: "frobnicate-cli", for: "frobnicating", install: { url: "https://example.com/frob" } }
const BD_HINT = "install: mise use -g aqua:gastownhall/beads, or see https://github.com/steveyegge/beads#install"

/** A directory of executables, each a shell script with the given body. */
function bins(tools: Record<string, string>): string {
  const dir = tempDir()
  for (const [name, body] of Object.entries(tools)) script(path.join(dir, name), body)
  return dir
}

/** An executable script at `file`, creating its directory. */
function exe(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  script(file, body)
}

/** A package tree holding `_kit/prereqs.json`, as harness-kit writes it. `under` nests the tree in a temp directory. */
function pkg(prerequisites: unknown[], under = ""): string {
  const root = path.join(tempDir(), under)
  mkdirSync(path.join(root, "_kit"), { recursive: true })
  writeFileSync(path.join(root, "_kit", "prereqs.json"), JSON.stringify({ plugin: "demo", prerequisites }))
  return root
}

const normalized = (item: Record<string, unknown>) => ({ required: false, ...item })

describe("prerequisites in the plugin settings", () => {
  const where = "plugins/demo/package.json"
  const field = "agent-plugins.prerequisites"
  const read = (raw: unknown) => readPrerequisites(where, field, raw)

  test("required defaults to false and every entry comes back with one key order", () => {
    const given = { version: "^1", install: { npm: "@scope/tool@^1.2.0", url: "https://example.com/t" }, for: "tooling", bin: "tool" }
    const [tool] = read([given]) ?? []
    expect(Object.keys(tool ?? {})).toEqual(["bin", "for", "required", "install", "version"])
    expect(tool).toEqual({ bin: "tool", for: "tooling", required: false, install: { url: "https://example.com/t", npm: "@scope/tool@^1.2.0" }, version: "^1" })
    expect(Object.keys(tool?.install ?? {})).toEqual(["url", "npm"])
    expect(read([BD])).toEqual([BD])
    expect(read(undefined)).toBeUndefined()
  })

  test.each([
    ["a non-list", "bd", /"agent-plugins\.prerequisites" must be a non-empty list/],
    ["an empty list", [], /"agent-plugins\.prerequisites" must be a non-empty list/],
    ["an entry that is not an object", ["bd"], /"agent-plugins\.prerequisites\[0\]" must be an object/],
    ["a missing bin", [{ for: "x", install: { url: "https://e.com" } }], /"agent-plugins\.prerequisites\[0\]\.bin" must be a non-empty string/],
    ["a bin with a path", [{ ...FROB, bin: "/usr/bin/frob" }], /"agent-plugins\.prerequisites\[0\]\.bin" must be a command name without a path/],
    ["a missing for", [{ bin: "frob", install: { url: "https://e.com" } }], /"agent-plugins\.prerequisites\[0\]\.for" must be a non-empty string/],
    ["a for over two lines", [{ ...FROB, for: "a\nb" }], /"agent-plugins\.prerequisites\[0\]\.for" must be one line/],
    ["a required that is not a boolean", [{ ...FROB, required: "yes" }], /"agent-plugins\.prerequisites\[0\]\.required" must be true or false/],
    ["a missing install", [{ bin: "frob", for: "x" }], /"agent-plugins\.prerequisites\[0\]\.install" must be an object/],
    ["an install without mise or url", [{ ...FROB, install: {} }], /"agent-plugins\.prerequisites\[0\]\.install" needs "mise", "url" or both/],
    ["an install with only npm", [{ ...FROB, install: { npm: "frob@^1" } }], /"agent-plugins\.prerequisites\[0\]\.install" needs "mise", "url" or both/],
    ["an install url that is not http(s)", [{ ...FROB, install: { url: "ftp://e.com" } }], /"agent-plugins\.prerequisites\[0\]\.install\.url" must be an http\(s\) URL/],
    ["a mise tool with spaces", [{ ...FROB, install: { mise: "mise use -g frob" } }], /"agent-plugins\.prerequisites\[0\]\.install\.mise" must be one mise tool/],
    ["an npm package without a range", [{ ...FROB, install: { url: "https://e.com", npm: "frob" } }], /"agent-plugins\.prerequisites\[0\]\.install\.npm" must be "<package>@<range>"/],
    ["an npm range that is not semver", [{ ...FROB, install: { url: "https://e.com", npm: "frob@latest" } }], /"agent-plugins\.prerequisites\[0\]\.install\.npm": "latest" is not a supported semver range/],
    ["a version that is not a supported range", [{ ...FROB, version: "1.2 - 2.0" }], /"agent-plugins\.prerequisites\[0\]\.version": "1\.2 - 2\.0" is not a supported semver range: cannot read "-"/],
    ["an unknown key", [{ ...FROB, optional: true }], /unknown key "agent-plugins\.prerequisites\[0\]\.optional"/],
    ["an unknown install key", [{ ...FROB, install: { url: "https://e.com", brew: "frob" } }], /unknown key "agent-plugins\.prerequisites\[0\]\.install\.brew"/],
    ["a bin listed twice", [FROB, FROB], /"agent-plugins\.prerequisites" lists "frobnicate-cli" twice/],
  ])("rejects %s, naming the file and the field", (_label, raw, message) => {
    expect(() => read(raw)).toThrow(message)
    expect(() => read(raw)).toThrow(/^plugins\/demo\/package\.json: /)
  })
})

describe("version ranges", () => {
  test.each([
    ["1.3.0", ">=1.3.0", true],
    ["1.2.9", ">=1.3.0", false],
    ["1.3.0", ">=1.3", true],
    ["2.0.0", ">1", true],
    ["1.9.9", ">1", false],
    ["1.2.4", ">1.2.3", true],
    ["1.2.3", "<1.2.3", false],
    ["1.2.9", "<=1.2", true],
    ["1.3.0", "<=1.2", false],
    ["1.4.0", "1.4", true],
    ["1.5.0", "1.x", true],
    ["2.0.0", "1.x", false],
    ["1.2.3", "=1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["1.9.0", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["0.2.9", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.0.4", "^0.0.3", false],
    ["0.0.9", "^0.0", true],
    ["0.1.0", "^0.0", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.9.0", "~1", true],
    ["5.0.0", "*", true],
    ["1.5.0", ">= 1.2 <2", true],
    ["2.1.0", ">=1.2 <2", false],
    ["3.1.0", "^1.0 || ^3.0", true],
    ["2.1.0", "^1.0 || ^3.0", false],
  ])("%s against %s is %p", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  test.each(["", "latest", ">=1.2.3-rc.1", "1.2.3.4", "1.x.3", "^1 ||", "1 - 2"])("rejects %p", (range) => {
    expect(() => parseRange(range)).toThrow(/semver range|empty alternative/)
  })

  test.each([
    ["bd version 1.4.2 (dev)", "1.4.2"],
    ["git version 2.43.0\n", "2.43.0"],
    ["chezmoi version v2.52.1, commit abc, built at 2024-09-01", "2.52.1"],
    ["Python 3.12", "3.12.0"],
    ["go1.22.3 darwin/arm64", "1.22.3"],
    ["tool 1.3.0-rc.1", "1.3.0"],
    ["no version here", undefined],
  ])("reads %p as %p", (output, version) => {
    expect(versionIn(output)).toBe(version)
  })
})

describe("the prerequisite check", () => {
  const ui = () => {
    const notices: Array<{ message: string; type: string }> = []
    return { notices, ctx: { hasUI: true, ui: { notify: (message: string, type: string) => void notices.push({ message, type }) } } }
  }
  const start = (root: string, PATH: string) => {
    const pi = fakePi()
    const lines: string[] = []
    prereqsExtension(pi.api, { root, env: { PATH }, stderr: (line) => void lines.push(line) })
    return { lines, session: (ctx: unknown) => pi.emit("session_start", { reason: "startup" }, ctx) }
  }

  test("is silent when every tool is present and new enough", () => {
    const tools = bins({ bd: 'echo "bd version 1.4.0"', "frobnicate-cli": "exit 0" })
    const run = start(pkg([BD, normalized(FROB)]), tools)
    const { notices, ctx } = ui()
    run.session(ctx)
    run.session({ hasUI: false })
    expect(notices).toEqual([])
    expect(run.lines).toEqual([])
  })

  test("names a missing tool, what it is for and its install hint, in one warning", () => {
    const run = start(pkg([BD, normalized(FROB)]), bins({ bd: 'echo "bd version 1.4.0"' }))
    const { notices, ctx } = ui()
    run.session(ctx)
    expect(notices).toEqual([{ message: "demo: prerequisites not met:\n- frobnicate-cli (for frobnicating): not on PATH; install: see https://example.com/frob", type: "warning" }])
  })

  test("names a tool whose version is too old, and lists every unmet tool in the same notice", () => {
    const run = start(pkg([BD, normalized(FROB)]), bins({ bd: 'echo "bd version 1.2.0 (dev)"' }))
    const { notices, ctx } = ui()
    run.session(ctx)
    expect(notices.map((notice) => notice.message)).toEqual([
      [
        "demo: prerequisites not met:",
        `- bd (required, for Beads gates and skills): version 1.2.0 does not satisfy >=1.3.0; ${BD_HINT}`,
        "- frobnicate-cli (for frobnicating): not on PATH; install: see https://example.com/frob",
      ].join("\n"),
    ])
  })

  test("without a UI writes one stderr line, once per process", () => {
    const run = start(pkg([BD, normalized(FROB)]), bins({ bd: 'echo "1.4.0"' }))
    run.session({ hasUI: false })
    run.session({ hasUI: false })
    expect(run.lines).toEqual(["demo: prerequisites not met: frobnicate-cli (for frobnicating): not on PATH; install: see https://example.com/frob"])
  })

  test("a session with a UI gets the notice at each start, and a session without one stays silent after it", () => {
    const run = start(pkg([normalized(FROB)]), bins({}))
    const { notices, ctx } = ui()
    run.session(ctx)
    run.session(ctx)
    run.session({ hasUI: false })
    expect(notices).toHaveLength(2)
    expect(run.lines).toEqual([])
  })

  test("a version that cannot be read, or a --version that outlasts the 2 s timeout, counts as unmet", () => {
    const tools = bins({ bd: "echo no number", slow: "exec sleep 5" })
    const slow = { bin: "slow", for: "waiting", required: true, install: { url: "https://e.com/slow" }, version: ">=1" }
    const root = pkg([BD, slow])
    const started = Date.now()
    expect(missingRequired({ root, env: { PATH: tools } })).toEqual(["bd", "slow"])
    expect(Date.now() - started).toBeLessThan(4500)
    expect(prereqMessage("bd", { root, env: { PATH: tools } })).toBe(`demo needs bd (required, for Beads gates and skills): cannot read its version from \`bd --version\` (needs >=1.3.0); ${BD_HINT}`)
  })

  test("missingRequired returns only the required tools that are unmet, and prereqMessage explains one", () => {
    const gate = { bin: "gatekeeper", for: "the commit gate", required: true, install: { mise: "aqua:o/gatekeeper" } }
    const root = pkg([BD, normalized(FROB), gate])
    const deps = { root, env: { PATH: bins({ bd: 'echo "bd 1.3.0"' }) } }
    expect(missingRequired(deps)).toEqual(["gatekeeper"])
    expect(prereqMessage("gatekeeper", deps)).toBe("demo needs gatekeeper (required, for the commit gate): not on PATH; install: mise use -g aqua:o/gatekeeper")
    expect(prereqMessage("bd", deps)).toBe("demo: bd is available")
    expect(() => prereqMessage("nope", deps)).toThrow('demo declares no prerequisite "nope"')
  })

  test("an npm prerequisite in the package's own or a hoisted node_modules/.bin counts as present; other tools are looked up on PATH only", () => {
    const repomix = { bin: "repomix", for: "packing", required: true, install: { url: "https://e.com/r", npm: "repomix@^1.2.0" } }
    const own = pkg([repomix])
    exe(path.join(own, "node_modules", ".bin", "repomix"), "exit 0")
    expect(missingRequired({ root: own, env: { PATH: bins({}) } })).toEqual([])

    const hoisted = pkg([repomix, { ...BD, version: undefined }], "node_modules/@srobroek/demo")
    const top = path.dirname(path.dirname(path.dirname(hoisted)))
    exe(path.join(top, "node_modules", ".bin", "repomix"), "exit 0")
    exe(path.join(top, "node_modules", ".bin", "bd"), "exit 0")
    expect(missingRequired({ root: hoisted, env: { PATH: bins({}) } })).toEqual(["bd"])
  })

  test("skips directories, non-executable files and relative PATH entries", () => {
    const dir = tempDir()
    mkdirSync(path.join(dir, "frobnicate-cli"))
    const plain = tempDir()
    writeFileSync(path.join(plain, "frobnicate-cli"), "#!/bin/sh\n")
    const required = { ...FROB, required: true }
    expect(missingRequired({ root: pkg([required]), env: { PATH: [dir, plain, "."].join(path.delimiter) } })).toEqual(["frobnicate-cli"])
    expect(missingRequired({ root: pkg([required]), env: { PATH: [dir, plain, bins({ "frobnicate-cli": "exit 0" })].join(path.delimiter) } })).toEqual([])
  })

  test("runs each check once per process: the session start and the gates share the result", () => {
    const counter = path.join(tempDir(), "runs")
    const tools = bins({ bd: `echo run >> "${counter}"; echo 1.4.0` })
    const root = pkg([BD])
    const run = start(root, tools)
    run.session({ hasUI: false })
    missingRequired({ root, env: { PATH: tools } })
    missingRequired({ root, env: { PATH: tools } })
    expect(readFileSync(counter, "utf8")).toBe("run\n")
  })
})

describe("generated prerequisite check", () => {
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
    return [...found.changed, ...found.extra]
  }
  const source = () => readFileSync(path.join(import.meta.dir, "..", "runtime", "pi", "prereqs.ts"), "utf8")

  beforeEach(() => {
    root = fixtureCopy()
    config = loadConfig(root)
    editOwn((own) => {
      own.harnesses.push("pi")
      own.prerequisites = [BD, FROB]
    })
  })

  test("the pi and OMP trees get the module and the plugin's list, and list the module as an extension", () => {
    generate()
    const data = { plugin: "demo", prerequisites: [BD, normalized(FROB)] }
    for (const harness of ["pi", "omp"]) {
      expect(readFileSync(demo(`${harness}/_kit/prereqs.ts`), "utf8")).toBe(`// Generated by scripts/build.ts. Do not edit.\n${source()}`)
      expect(readJson(`${harness}/_kit/prereqs.json`)).toEqual(data)
    }
    expect(readJson("pi/package.json").pi.extensions).toEqual(["./_kit/rules.ts", "./_kit/prereqs.ts"])
    expect(readJson("omp/package.json").omp).toEqual({ extensions: ["./extensions/demo-ext.ts", "./_kit/prereqs.ts"] })
    for (const harness of ["opencode", "claude"]) expect(existsSync(demo(`${harness}/_kit`))).toBe(false)
    expect(stale()).toEqual([])
  })

  test("a changed list is stale until rebuilt, and dropping the list removes the files and the extension entries", () => {
    generate()
    editOwn((own) => (own.prerequisites = [FROB]))
    expect(stale().map((file) => path.relative(root, file)).sort()).toEqual(["inventory.json", "plugins/demo/INVENTORY.md", "plugins/demo/omp/_kit/prereqs.json", "plugins/demo/pi/_kit/prereqs.json"])
    editOwn((own) => delete own.prerequisites)
    generate()
    expect(existsSync(demo("omp/_kit"))).toBe(false)
    expect(existsSync(demo("pi/_kit/prereqs.ts"))).toBe(false)
    expect(existsSync(demo("pi/_kit/prereqs.json"))).toBe(false)
    expect(readJson("pi/package.json").pi.extensions).toEqual(["./_kit/rules.ts"])
    expect(readJson("omp/package.json").omp).toEqual({ extensions: ["./extensions/demo-ext.ts"] })
    expect(JSON.parse(readFileSync(path.join(root, "inventory.json"), "utf8")).plugins[0]).not.toHaveProperty("prerequisites")
    expect(stale()).toEqual([])
  })

  test("the inventory lists the prerequisites whatever the harnesses, OpenCode and Claude included", () => {
    rmSync(demo("omp"), { recursive: true })
    editOwn((own) => (own.harnesses = ["opencode", "claude"]))
    generate()
    expect(JSON.parse(readFileSync(path.join(root, "inventory.json"), "utf8")).plugins[0].prerequisites).toEqual([BD, normalized(FROB)])
    expect(readFileSync(demo("INVENTORY.md"), "utf8")).toEndWith(
      [
        "| mcp | - | demo-server |",
        "",
        "## Prerequisites",
        "",
        "| Tool | Required | Version | For | Install |",
        "| --- | --- | --- | --- | --- |",
        "| bd | yes | >=1.3.0 | Beads gates and skills | mise use -g aqua:gastownhall/beads, or see https://github.com/steveyegge/beads#install |",
        "| frobnicate-cli | no | any | frobnicating | see https://example.com/frob |",
        "",
      ].join("\n"),
    )
    expect(existsSync(demo("opencode/_kit"))).toBe(false)
    expect(existsSync(demo("claude/_kit"))).toBe(false)
  })

  test("the vendored copy reads the list next to it", async () => {
    generate()
    const vendored = (await import(demo("pi/_kit/prereqs.ts"))) as typeof import("../runtime/pi/prereqs.ts")
    expect(vendored.missingRequired({ env: { PATH: bins({ bd: 'echo "bd 1.0.0"' }) } })).toEqual(["bd"])
  })

  describe("validate-pi", () => {
    const problems = () => prerequisiteProblems(demo("pi"), readPlugins(root, config)[0] as never)

    test("a generated tree passes", () => {
      generate()
      expect(problems()).toEqual([])
      expect(validatePi(root, config)).toBe(0)
    })

    test.each([
      ["a list that differs from the metadata", () => writeFileSync(demo("pi/_kit/prereqs.json"), JSON.stringify({ plugin: "demo", prerequisites: [BD] })), '_kit/prereqs.json: does not match "prerequisites" in plugins/demo/package.json'],
      ["a list that is not JSON", () => writeFileSync(demo("pi/_kit/prereqs.json"), "{"), "_kit/prereqs.json: not valid JSON"],
      ["a missing list", () => rmSync(demo("pi/_kit/prereqs.json")), "_kit/prereqs.json: missing, but the plugin declares prerequisites"],
      ["a missing module", () => rmSync(demo("pi/_kit/prereqs.ts")), "_kit/prereqs.ts: missing, but the plugin declares prerequisites"],
      [
        "a manifest that does not list the module",
        () => writeFileSync(demo("pi/package.json"), JSON.stringify({ ...readJson("pi/package.json"), pi: { extensions: ["./_kit/rules.ts"] } })),
        'package.json: "pi.extensions" must list "./_kit/prereqs.ts"',
      ],
    ])("reports %s", (_label, breakIt, message) => {
      generate()
      breakIt()
      expect(problems().join("\n")).toContain(message)
      expect(validatePi(root, config)).toBe(1)
    })

    test("reports leftover files of a plugin that declares no prerequisites", () => {
      generate()
      editOwn((own) => delete own.prerequisites)
      expect(problems()).toEqual([
        "_kit/prereqs.ts: the plugin declares no prerequisites; run harness-kit build to remove it",
        "_kit/prereqs.json: the plugin declares no prerequisites; run harness-kit build to remove it",
      ])
    })
  })
})
