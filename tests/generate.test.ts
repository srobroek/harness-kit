import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type Config, loadConfig } from "../src/config"
import { drift, readPlugins, render, stampVersion, write } from "../src/generate"

const FIXTURE = path.join(import.meta.dir, "fixtures", "repo")

let root: string
let config: Config

beforeEach(() => {
  root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "harness-kit-test-"))
  cpSync(FIXTURE, root, { recursive: true })
  config = loadConfig(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const generate = () => write(root, render(root, readPlugins(root, config), config), config)
const staleFiles = () => {
  const found = drift(root, render(root, readPlugins(root, config), config), config)
  return [...found.changed, ...found.extra].map((file) => path.relative(root, file)).sort()
}
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
const demo = (file: string) => path.join("plugins", "demo", file)


describe("MCP declarations", () => {
  test("generates safe declarations per harness and check detects their drift", () => {
    const manifestPath = path.join(root, demo("package.json"))
    const manifest = readJson(demo("package.json"))
    manifest["agent-plugins"].harnesses.push("pi")
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const source = path.join(root, demo("common/.mcp.json"))
    mkdirSync(path.dirname(source), { recursive: true })
    writeFileSync(source, JSON.stringify({
      mcpServers: {
        enabled: { command: "enabled-server" },
        disabled: { command: "disabled-server", enabled: false },
        keyless: { command: "context7", optionalHeaders: { "x-apikey": "CONTEXT7_API_KEY" }, headers: { "x-apikey": "${CONTEXT7_API_KEY}" } },
        required: { command: "private-server", env: { API_KEY: "${API_KEY}" }, requiredEnv: ["API_KEY"] },
      },
    }, null, 2) + "\n")
    generate()
    const output = () => render(root, readPlugins(root, config), config).filter((item) => item.file.endsWith("mcp.json") || item.file.endsWith("mcp-servers.ts"))
    const withoutBuildKey = output().map((item) => item.contents).join("\n")
    const previous = process.env.API_KEY
    process.env.API_KEY = "must-not-be-written"
    try {
      expect(output().map((item) => item.contents).join("\n")).toBe(withoutBuildKey)
      expect(output().map((item) => item.contents).join("\n")).not.toContain("must-not-be-written")
      expect(readJson(demo("omp/mcp.json")).mcpServers.required.env.API_KEY).toBe("${API_KEY}")
      expect(readJson(demo("claude/.mcp.json")).mcpServers.required.env.API_KEY).toBe("${API_KEY}")
    } finally {
      if (previous === undefined) delete process.env.API_KEY
      else process.env.API_KEY = previous
    }
    expect(staleFiles().filter((file) => file.endsWith("mcp.json") || file.endsWith("mcp-servers.ts"))).toEqual([])
    expect(readJson(demo("pi/package.json")).pi.extensions).toContain("./mcp-servers.ts")
    expect(readJson("inventory.json").plugins[0].harnesses.omp.mcp).toEqual(["enabled", "keyless", "required"])
    writeFileSync(path.join(root, demo("omp/mcp.json")), "{}\n")
    expect(staleFiles()).toContain(demo("omp/mcp.json"))
    rmSync(source)
    expect(staleFiles().filter((file) => file.endsWith("mcp.json") || file.endsWith("mcp-servers.ts"))).toEqual([demo("claude/.mcp.json"), demo("pi/mcp-servers.ts")].sort())
  })
})

describe("harness manifests", () => {
  test("claude plugin.json takes name, description and version from package.json", () => {
    generate()
    expect(readJson(demo("claude/.claude-plugin/plugin.json"))).toEqual({
      name: "demo",
      description: "Fixture plugin for the generator tests.",
      version: "1.2.3",
      author: { name: "Fixture Owner" },
      license: "UNLICENSED",
      userConfig: {
        greeting: { type: "string", title: "greeting", description: "Word the demo template opens with.", default: "hello" },
      },
    })
  })

  test("omp package.json carries the omp key listing extension modules, and plugin.json mirrors the metadata", () => {
    generate()
    expect(readJson(demo("omp/package.json"))).toEqual({
      name: "@agent-plugins/demo",
      version: "1.2.3",
      description: "Fixture plugin for the generator tests.",
      private: true,
      omp: { extensions: ["./extensions/demo-ext.ts"] },
    })
    expect(readJson(demo("omp/.omp-plugin/plugin.json"))).toEqual({
      name: "demo",
      description: "Fixture plugin for the generator tests.",
      version: "1.2.3",
      category: "development",
    })
  })

  test("omp package.json has an empty omp key when the plugin ships no extension modules", () => {
    rmSync(path.join(root, demo("omp/extensions")), { recursive: true })
    generate()
    expect(readJson(demo("omp/package.json")).omp).toEqual({})
  })

  test("opencode package.json names the entry point, exports the TUI half when tui.js exists, and carries the version", () => {
    generate()
    expect(readJson(demo("opencode/package.json"))).toEqual({
      name: "demo-opencode",
      version: "1.2.3",
      private: true,
      type: "module",
      exports: { ".": "./index.js", "./tui": "./tui.js" },
      peerDependencies: { "@opencode/plugin": ">=2.1.4 <3" },
      peerDependenciesMeta: { "@opencode/plugin": { optional: true } },
    })
  })

  test("opencode package.json of a TUI-only plugin exports only ./tui", () => {
    rmSync(path.join(root, demo("opencode/index.js")))
    generate()
    expect(readJson(demo("opencode/package.json")).exports).toEqual({ "./tui": "./tui.js" })
  })
})

describe("common content", () => {
  test.each(["opencode", "claude", "omp"])("is copied byte for byte into the %s tree", (harness) => {
    generate()
    // OMP rules gain front matter; the next describe block covers them.
    const files = ["skills/demo-skill/SKILL.md", "templates/demo-template.md", ...(harness === "omp" ? [] : ["rules/demo-rule.md"])]
    for (const file of files) expect(read(demo(`${harness}/${file}`))).toBe(read(demo(`common/${file}`)))
  })

  describe("OMP rules", () => {
    const addCommon = (file: string, text: string) => writeFileSync(path.join(root, demo(`common/${file}`)), text)

    test("a rule without front matter gets alwaysApply, because OMP injects nothing else into the system prompt", () => {
      generate()
      expect(read(demo("omp/rules/demo-rule.md"))).toBe(`---\nalwaysApply: true\n---\n\n${read(demo("common/rules/demo-rule.md"))}`)
    })

    test("a rule with an explicit description stays on demand: the generator adds no alwaysApply", () => {
      addCommon("rules/own.md", "---\ndescription: on demand\n---\nBody\n")
      generate()
      const text = read(demo("omp/rules/own.md"))
      expect(text).toBe("---\ndescription: on demand\n---\nBody\n")
      expect(text).not.toContain("alwaysApply")
    })

    test("the other harnesses keep the rule without front matter", () => {
      generate()
      for (const harness of ["opencode", "claude"]) expect(read(demo(`${harness}/rules/demo-rule.md`))).not.toContain("alwaysApply")
    })
  })

  describe("harness variants", () => {
    const addCommon = (file: string, text: string) => writeFileSync(path.join(root, demo(`common/${file}`)), text)

    test("x.<harness>.md replaces x.md in that harness only", () => {
      addCommon("rules/demo-rule.claude.md", "claude wording\n")
      generate()
      expect(read(demo("claude/rules/demo-rule.md"))).toBe("claude wording\n")
      expect(read(demo("opencode/rules/demo-rule.md"))).toBe(read(demo("common/rules/demo-rule.md")))
      expect(read(demo("omp/rules/demo-rule.md"))).toContain(read(demo("common/rules/demo-rule.md")))
    })

    test("the variant file itself is not copied under its own name", () => {
      addCommon("rules/demo-rule.claude.md", "claude wording\n")
      generate()
      expect(existsSync(path.join(root, demo("claude/rules/demo-rule.claude.md")))).toBe(false)
      expect(staleFiles()).toEqual([])
    })

    test("a variant with no plain file is delivered to its harness alone", () => {
      addCommon("rules/only-omp.omp.md", "omp only\n")
      generate()
      expect(read(demo("omp/rules/only-omp.md"))).toContain("omp only")
      expect(existsSync(path.join(root, demo("opencode/rules/only-omp.md")))).toBe(false)
      expect(existsSync(path.join(root, demo("claude/rules/only-omp.md")))).toBe(false)
    })
  })

  test("is not copied into a harness the plugin does not list", () => {
    const manifest = readJson(demo("package.json"))
    manifest["agent-plugins"].harnesses = ["claude"]
    writeFileSync(path.join(root, demo("package.json")), JSON.stringify(manifest))
    for (const harness of ["opencode", "omp"]) rmSync(path.join(root, demo(harness)), { recursive: true })
    generate()
    expect(existsSync(path.join(root, demo("claude/skills/demo-skill/SKILL.md")))).toBe(true)
    expect(existsSync(path.join(root, demo("omp")))).toBe(false)
    expect(existsSync(path.join(root, demo("opencode")))).toBe(false)
  })
})

describe("options", () => {
  test.each(["opencode", "claude", "omp"])("the %s tree gets options.json holding each option's default", (harness) => {
    generate()
    expect(readJson(demo(`${harness}/options.json`))).toEqual({ greeting: "hello" })
  })

  test("a plugin without options gets neither options.json nor userConfig", () => {
    const manifest = readJson(demo("package.json"))
    delete manifest["agent-plugins"].options
    writeFileSync(path.join(root, demo("package.json")), JSON.stringify(manifest))
    generate()
    expect(existsSync(path.join(root, demo("omp/options.json")))).toBe(false)
    expect(readJson(demo("claude/.claude-plugin/plugin.json")).userConfig).toBeUndefined()
  })
})

describe("marketplaces", () => {
  test("list each plugin under the harnesses it supports, with the source path of that harness tree", () => {
    generate()
    const claude = readJson(".claude-plugin/marketplace.json")
    const omp = readJson(".omp-plugin/marketplace.json")
    expect(claude.plugins).toEqual([
      {
        name: "demo",
        description: "Fixture plugin for the generator tests.",
        source: "./plugins/demo/claude",
        version: "1.2.3",
        category: "development",
      },
    ])
    expect(omp.plugins).toEqual([{ ...claude.plugins[0], source: "./plugins/demo/omp" }])
  })

  test("an empty plugin set yields empty marketplaces and passes the check", () => {
    rmSync(path.join(root, "plugins"), { recursive: true })
    mkdirSync(path.join(root, "plugins"))
    generate()
    expect(readJson(".claude-plugin/marketplace.json").plugins).toEqual([])
    expect(readJson(".omp-plugin/marketplace.json").plugins).toEqual([])
    expect(readJson("inventory.json").plugins).toEqual([])
    expect(staleFiles()).toEqual([])
  })
})

describe("inventory", () => {
  test("plugin INVENTORY.md has one column per harness and one row per kind", () => {
    generate()
    expect(read(demo("INVENTORY.md"))).toBe(
      [
        "<!-- Generated by scripts/build.ts. Do not edit. -->",
        "# demo",
        "",
        "Fixture plugin for the generator tests.",
        "",
        "| Kind | opencode | claude | omp |",
        "| --- | --- | --- | --- |",
        "| skills | demo-skill | demo-skill | demo-skill |",
        "| agents | - | - | - |",
        "| commands | - | - | - |",
        "| rules | demo-rule | demo-rule | demo-rule |",
        "| templates | demo-template | demo-template | demo-template |",
        "| styles | - | demo-style | - |",
        "| hooks | - | SessionStart | pre/guard |",
        "| tools | - | - | - |",
        "| extensions | index, tui | - | demo-ext |",
        "| mcp | - | demo-server | - |",
        "",
      ].join("\n"),
    )
  })

  test("inventory.json records version, scope and the per-harness contents", () => {
    generate()
    const { plugins } = readJson("inventory.json")
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({
      name: "demo",
      version: "1.2.3",
      category: "development",
      scope: "work",
      harnesses: {
        opencode: { skills: ["demo-skill"], extensions: ["index", "tui"] },
        claude: { hooks: ["SessionStart"], mcp: ["demo-server"], styles: ["demo-style"], templates: ["demo-template"] },
        omp: { rules: ["demo-rule"], hooks: ["pre/guard"], extensions: ["demo-ext"] },
      },
    })
  })

  test("root INVENTORY.md lists every plugin with its harnesses", () => {
    generate()
    const text = read("INVENTORY.md")
    expect(text).toContain("| demo | 1.2.3 | development | work | opencode, claude, omp |")
  })

  test("root INVENTORY.md summarises each plugin's harness discrepancies on one line, and inventory.json keeps them", () => {
    generate()
    expect(read("INVENTORY.md")).toContain("## Harness discrepancies\n\n- demo: The fixture binds differently in each harness.\n")
    expect(readJson("inventory.json").plugins[0].discrepancies).toBe("The fixture binds differently in each harness.")
  })

  test("a plugin without discrepancies gets no entry in the discrepancy section", () => {
    const manifest = readJson(demo("package.json"))
    delete manifest["agent-plugins"].discrepancies
    writeFileSync(path.join(root, demo("package.json")), JSON.stringify(manifest))
    generate()
    expect(read("INVENTORY.md")).not.toContain("Harness discrepancies")
  })
})

describe.each([
  { kind: "common", from: "plugins/demo/common/skills/demo-skill/run.py" },
  { kind: "shared", from: "shared/skills/tool-skill/run.py", dest: "skills/tool-skill/run.py" },
])("executable bit ($kind source)", ({ from, dest = "skills/demo-skill/run.py" }) => {
  const source = () => path.join(root, from)
  const copies = () => ["opencode", "claude", "omp"].map((h) => path.join(root, demo(`${h}/${dest}`)))
  const isExec = (file: string) => (statSync(file).mode & 0o111) !== 0
  beforeEach(() => {
    mkdirSync(path.dirname(source()), { recursive: true })
    writeFileSync(source(), "#!/usr/bin/env python3\n")
    chmodSync(source(), 0o755)
    if (from.startsWith("shared/")) {
      const manifest = JSON.parse(read("plugins/demo/package.json"))
      manifest["agent-plugins"].shared = ["skills/tool-skill"]
      writeFileSync(path.join(root, "plugins/demo/package.json"), JSON.stringify(manifest))
    }
  })

  test("copies of an executable source are executable", () => {
    generate()
    expect(copies().map(isExec)).toEqual([true, true, true])
  })

  test("copies of a plain source are not executable", () => {
    chmodSync(source(), 0o644)
    generate()
    expect(copies().map(isExec)).toEqual([false, false, false])
  })

  test("a copy that lost the bit is stale, and write restores it", () => {
    generate()
    chmodSync(copies()[0]!, 0o644)
    expect(staleFiles()).toEqual([demo(`opencode/${dest}`)])
    generate()
    expect(isExec(copies()[0]!)).toBe(true)
    expect(staleFiles()).toEqual([])
  })

  test("a copy that lost only the owner bit is stale, and write restores it", () => {
    generate()
    chmodSync(copies()[0]!, 0o655)
    expect(staleFiles()).toEqual([demo(`opencode/${dest}`)])
    generate()
    expect(statSync(copies()[0]!).mode & 0o100).toBe(0o100)
    expect(staleFiles()).toEqual([])
  })

  test("dropping the bit from the source clears it on the copies", () => {
    generate()
    chmodSync(source(), 0o644)
    expect(staleFiles()).toHaveLength(3)
    generate()
    expect(copies().map(isExec)).toEqual([false, false, false])
  })
})

describe("--check semantics", () => {
  test("a freshly generated tree has no drift", () => {
    generate()
    expect(staleFiles()).toEqual([])
  })

  test("an empty tree reports every generated file as stale", () => {
    expect(staleFiles()).toContain(".claude-plugin/marketplace.json")
    expect(staleFiles()).toContain(demo("claude/.claude-plugin/plugin.json"))
  })

  test("a hand-edited manifest is stale", () => {
    generate()
    writeFileSync(path.join(root, demo("claude/.claude-plugin/plugin.json")), "{}\n")
    expect(staleFiles()).toEqual([demo("claude/.claude-plugin/plugin.json")])
  })

  test("a changed common file makes every harness copy stale", () => {
    generate()
    writeFileSync(path.join(root, demo("common/rules/demo-rule.md")), "# Changed\n")
    expect(staleFiles()).toEqual(
      ["opencode", "claude", "omp"].map((harness) => demo(`${harness}/rules/demo-rule.md`)).sort(),
    )
  })

  test("a file left behind in a common-owned directory is stale", () => {
    generate()
    mkdirSync(path.join(root, demo("omp/skills/removed")), { recursive: true })
    writeFileSync(path.join(root, demo("omp/skills/removed/SKILL.md")), "x")
    expect(staleFiles()).toEqual([demo("omp/skills/removed/SKILL.md")])
  })

  test("write removes stale files and leaves hand-authored files alone", () => {
    generate()
    writeFileSync(path.join(root, demo("omp/rules/orphan.md")), "x")
    generate()
    expect(existsSync(path.join(root, demo("omp/rules/orphan.md")))).toBe(false)
    expect(existsSync(path.join(root, demo("omp/extensions/demo-ext.ts")))).toBe(true)
    expect(staleFiles()).toEqual([])
  })
})

describe("stampVersion", () => {
  test("sets the version in package.json, every manifest and both marketplaces", () => {
    generate()
    stampVersion(root, "demo", "2.0.0", config)
    expect(readJson(demo("package.json")).version).toBe("2.0.0")
    expect(readJson(demo("claude/.claude-plugin/plugin.json")).version).toBe("2.0.0")
    expect(readJson(demo("omp/package.json")).version).toBe("2.0.0")
    expect(readJson(demo("omp/.omp-plugin/plugin.json")).version).toBe("2.0.0")
    expect(readJson(demo("opencode/package.json")).version).toBe("2.0.0")
    expect(readJson(".claude-plugin/marketplace.json").plugins[0].version).toBe("2.0.0")
    expect(readJson(".omp-plugin/marketplace.json").plugins[0].version).toBe("2.0.0")
    expect(readJson("inventory.json").plugins[0].version).toBe("2.0.0")
    expect(staleFiles()).toEqual([])
  })

  test.each(["2", "v2.0.0", "2.0.0.1", ""])("rejects the version %p", (version) => {
    expect(() => stampVersion(root, "demo", version, config)).toThrow(/semver/)
  })

  test("rejects an unknown plugin", () => {
    expect(() => stampVersion(root, "nope", "1.0.0", config)).toThrow(/unknown plugin/)
  })
})

describe("OpenCode entry files", () => {
  const entry = (file: string, text: string) => writeFileSync(path.join(root, demo(`opencode/${file}`)), text)

  test.each([
    ["a bare import", 'import { Plugin } from "@opencode/plugin"\nexport default Plugin\n'],
    ["a bare re-export", 'export * from "solid-js"\n'],
    ["a side-effect import", 'import "@opentui/solid"\n'],
  ])("rejects an entry with %s", (_label, text) => {
    entry("index.js", text)
    expect(() => readPlugins(root, config)).toThrow(/imports ".*" directly/)
  })

  test("rejects a TUI entry that imports a host package", () => {
    entry("tui.js", 'import { createSignal } from "solid-js"\nexport default {}\n')
    expect(() => readPlugins(root, config)).toThrow(/tui\.js/)
  })

  test("accepts a shim that re-exports a sibling module, and node builtins", () => {
    entry("main.js", 'import { Plugin } from "@opencode/plugin"\nexport default Plugin\n')
    entry("index.js", 'import { join } from "node:path"\nexport { default } from "./main.js"\nexport * from "./main.js"\n')
    expect(() => readPlugins(root, config)).not.toThrow()
  })
})

describe("validation", () => {
  const edit = (change: (manifest: any) => void) => {
    const file = path.join(root, demo("package.json"))
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    change(manifest)
    writeFileSync(file, JSON.stringify(manifest))
  }

  test.each([
    ["an unknown harness", (m: any) => (m["agent-plugins"].harnesses = ["codex"]), /harness/],
    ["no harnesses", (m: any) => (m["agent-plugins"].harnesses = []), /harness/],
    ["a multi-line discrepancies note", (m: any) => (m["agent-plugins"].discrepancies = "a\nb"), /discrepancies/],
    ["an option name with capitals", (m: any) => (m["agent-plugins"].options = { Bad: { description: "x", default: "y" } }), /option "Bad"/],
    ["an option without a string default", (m: any) => (m["agent-plugins"].options.greeting.default = 3), /default/],
    ["an option without a description", (m: any) => delete m["agent-plugins"].options.greeting.description, /description/],
    ["a missing description", (m: any) => delete m["agent-plugins"].description, /description/],
    ["a missing agent-plugins key", (m: any) => delete m["agent-plugins"], /agent-plugins/],
    ["a non-semver version", (m: any) => (m.version = "latest"), /version/],
    ["a name that differs from the directory", (m: any) => (m.name = "other"), /name/],
  ])("rejects %s", (_label, change, message) => {
    edit(change)
    expect(() => readPlugins(root, config)).toThrow(message)
  })

  test("rejects a harness tree the plugin does not list", () => {
    edit((m) => (m["agent-plugins"].harnesses = ["claude", "omp"]))
    expect(() => readPlugins(root, config)).toThrow(/opencode/)
  })
})

describe("Claude identity (claudeName, author, license, userConfig)", () => {
  const edit = (change: (manifest: any) => void) => {
    const file = path.join(root, demo("package.json"))
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    change(manifest)
    writeFileSync(file, JSON.stringify(manifest))
  }
  const rawUserConfig = { strict: { type: "boolean", title: "Strict", description: "Fixture option." } }
  const useRawUserConfig = () =>
    edit((m) => {
      delete m["agent-plugins"].options
      m["agent-plugins"].claudeName = "demo-cc"
      m["agent-plugins"].userConfig = rawUserConfig
      m.author = { name: "Plugin Author" }
      m.license = "MIT"
    })

  test("plugin.json takes the name override, author, license and raw userConfig from package.json", () => {
    useRawUserConfig()
    generate()
    expect(readJson(demo("claude/.claude-plugin/plugin.json"))).toEqual({
      name: "demo-cc",
      description: "Fixture plugin for the generator tests.",
      version: "1.2.3",
      author: { name: "Plugin Author" },
      license: "MIT",
      userConfig: rawUserConfig,
    })
  })

  test("a string author becomes { name }", () => {
    edit((m) => (m.author = "Plain Name"))
    generate()
    expect(readJson(demo("claude/.claude-plugin/plugin.json")).author).toEqual({ name: "Plain Name" })
  })

  test("without package.json values and without config defaults, plugin.json omits author and license", () => {
    config.claude = { strict: true }
    edit((m) => delete m["agent-plugins"].options)
    generate()
    expect(readJson(demo("claude/.claude-plugin/plugin.json"))).toEqual({
      name: "demo",
      description: "Fixture plugin for the generator tests.",
      version: "1.2.3",
    })
  })

  test("the package.json author wins over the config default", () => {
    edit((m) => (m.author = { name: "Plugin Author" }))
    generate()
    expect(readJson(demo("claude/.claude-plugin/plugin.json")).author).toEqual({ name: "Plugin Author" })
  })

  test("only the Claude marketplace uses claudeName", () => {
    useRawUserConfig()
    generate()
    expect(readJson(".claude-plugin/marketplace.json").plugins[0].name).toBe("demo-cc")
    expect(readJson(".omp-plugin/marketplace.json").plugins[0].name).toBe("demo")
  })

  test("inventory.json keeps claudeName but drops author, license and userConfig", () => {
    useRawUserConfig()
    generate()
    const entry = readJson("inventory.json").plugins[0]
    expect(entry.claudeName).toBe("demo-cc")
    for (const key of ["author", "license", "userConfig"]) expect(entry).not.toHaveProperty(key)
  })

  test("raw userConfig produces no options.json", () => {
    useRawUserConfig()
    generate()
    expect(existsSync(path.join(root, demo("claude/options.json")))).toBe(false)
  })

  test.each([
    ["options and userConfig together", (m: any) => (m["agent-plugins"].userConfig = rawUserConfig), /either .*options.* or .*userConfig/],
    ["a claudeName that is not kebab-case", (m: any) => (m["agent-plugins"].claudeName = "Not Valid"), /claudeName/],
    ["a userConfig that is not an object", (m: any) => (m["agent-plugins"].userConfig = []), /userConfig/],
    ["an author without a name", (m: any) => (m.author = { nick: "x" }), /author/],
    ["an empty license", (m: any) => (m.license = ""), /license/],
  ])("rejects %s", (_label, change, message) => {
    edit(change)
    expect(() => readPlugins(root, config)).toThrow(message)
  })
})

describe("config-driven behaviour", () => {
  const addCommon = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, demo(`common/${file}`))), { recursive: true })
    writeFileSync(path.join(root, demo(`common/${file}`)), text)
  }

  test.each(["opencode", "claude", "omp"])("a configured commonDir is copied into the %s tree, and __pycache__ is skipped", (harness) => {
    config.commonDirs = [...config.commonDirs, "scripts", "formulas"]
    addCommon("scripts/helper.py", "print('hi')\n")
    addCommon("scripts/__pycache__/helper.cpython-312.pyc", "bytecode")
    addCommon("formulas/flow.formula.toml", 'formula = "flow"\n')
    generate()
    for (const file of ["scripts/helper.py", "formulas/flow.formula.toml"]) expect(read(demo(`${harness}/${file}`))).toBe(read(demo(`common/${file}`)))
    expect(existsSync(path.join(root, demo(`${harness}/scripts/__pycache__`)))).toBe(false)
    expect(staleFiles()).toEqual([])
  })

  test("a directory not listed in commonDirs is not copied", () => {
    addCommon("scripts/helper.py", "print('hi')\n")
    generate()
    expect(existsSync(path.join(root, demo("claude/scripts")))).toBe(false)
  })

  test("a script removed from common/ is removed from the harness trees", () => {
    config.commonDirs = [...config.commonDirs, "scripts"]
    addCommon("scripts/helper.py", "print('hi')\n")
    generate()
    rmSync(path.join(root, demo("common/scripts/helper.py")))
    expect(staleFiles()).toEqual(["opencode", "claude", "omp"].map((harness) => demo(`${harness}/scripts/helper.py`)).sort())
    generate()
    expect(existsSync(path.join(root, demo("claude/scripts/helper.py")))).toBe(false)
  })

  test("kinds limits the inventory rows and the inventory.json keys", () => {
    config.kinds = ["skills", "rules"]
    generate()
    expect(read(demo("INVENTORY.md"))).toContain("| rules | demo-rule | demo-rule | demo-rule |\n")
    expect(read(demo("INVENTORY.md"))).not.toContain("| styles |")
    expect(Object.keys(readJson("inventory.json").plugins[0].harnesses.claude)).toEqual(["skills", "rules"])
  })

  test("the marketplace name, description and owner come from the config", () => {
    generate()
    for (const file of [".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json"]) {
      const market = readJson(file)
      expect(market.name).toBe("fixture-plugins")
      expect(market.owner).toEqual({ name: "Fixture Owner" })
      expect(market.metadata).toEqual({ description: "Fixture marketplace." })
    }
  })

  test("generatedBy names the generator in generated Markdown", () => {
    config.generatedBy = "harness-kit build"
    generate()
    expect(read("INVENTORY.md").startsWith("<!-- Generated by harness-kit build. Do not edit. -->\n")).toBe(true)
    expect(read(demo("INVENTORY.md"))).toContain("Generated by harness-kit build.")
  })

  test("omp.packageType adds a type field to the OMP package.json, and its absence leaves it out", () => {
    generate()
    expect(readJson(demo("omp/package.json"))).not.toHaveProperty("type")
    config.omp = { packageType: "module" }
    generate()
    expect(readJson(demo("omp/package.json")).type).toBe("module")
  })

  test("ompScope sets the OMP package name", () => {
    config.ompScope = "@mine"
    generate()
    expect(readJson(demo("omp/package.json")).name).toBe("@mine/demo")
  })

  test("pluginKey names the package.json key that holds the plugin settings", () => {
    config.pluginKey = "my-plugins"
    const manifest = readJson(demo("package.json"))
    manifest["my-plugins"] = manifest["agent-plugins"]
    delete manifest["agent-plugins"]
    writeFileSync(path.join(root, demo("package.json")), JSON.stringify(manifest))
    expect(() => generate()).not.toThrow()
  })

  test("a harness left out of the config gets no marketplace and cannot be listed by a plugin", () => {
    config.harnesses = ["opencode", "claude"]
    expect(() => readPlugins(root, config)).toThrow(/"omp" is not enabled in harness-kit.json/)
    const manifest = readJson(demo("package.json"))
    manifest["agent-plugins"].harnesses = ["opencode", "claude"]
    writeFileSync(path.join(root, demo("package.json")), JSON.stringify(manifest))
    rmSync(path.join(root, demo("omp")), { recursive: true })
    generate()
    expect(existsSync(path.join(root, ".claude-plugin/marketplace.json"))).toBe(true)
    expect(existsSync(path.join(root, ".omp-plugin"))).toBe(false)
  })
})

describe("Claude manifest links and dependencies", () => {
  const edit = (change: (manifest: any) => void) => {
    const file = path.join(root, demo("package.json"))
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    change(manifest)
    writeFileSync(file, JSON.stringify(manifest))
  }
  const pluginJson = () => readJson(demo("claude/.claude-plugin/plugin.json"))
  const entry = () => readJson(".claude-plugin/marketplace.json").plugins[0]

  test("with none of the new keys set, plugin.json and the marketplace entry keep their bytes", () => {
    generate()
    expect(read(demo("claude/.claude-plugin/plugin.json"))).toBe(
      JSON.stringify(
        {
          name: "demo",
          description: "Fixture plugin for the generator tests.",
          version: "1.2.3",
          author: { name: "Fixture Owner" },
          license: "UNLICENSED",
          userConfig: {
            greeting: { type: "string", title: "greeting", description: "Word the demo template opens with.", default: "hello" },
          },
        },
        null,
        2,
      ) + "\n",
    )
    expect(Object.keys(entry())).toEqual(["name", "description", "source", "version", "category"])
  })

  test("repo-level homepage, repository and author.url reach plugin.json; homepage and repository reach only the Claude marketplace entry", () => {
    config.claude = { strict: true, license: "UNLICENSED", author: { name: "Fixture Owner", url: "https://example.com/owner" }, homepage: "https://example.com", repository: "https://github.com/o/r" }
    generate()
    expect(pluginJson()).toMatchObject({ homepage: "https://example.com", repository: "https://github.com/o/r", author: { name: "Fixture Owner", url: "https://example.com/owner" } })
    expect(entry()).toMatchObject({ homepage: "https://example.com", repository: "https://github.com/o/r" })
    expect(readJson(".omp-plugin/marketplace.json").plugins[0]).not.toHaveProperty("homepage")
  })

  test("a plugin's claude.homepage and claude.repository override the repo defaults", () => {
    config.claude = { strict: true, homepage: "https://example.com", repository: "https://github.com/o/r" }
    edit((m) => (m["agent-plugins"].claude = { homepage: "https://demo.example.com", repository: "https://github.com/o/demo" }))
    generate()
    expect(pluginJson()).toMatchObject({ homepage: "https://demo.example.com", repository: "https://github.com/o/demo" })
    expect(entry()).toMatchObject({ homepage: "https://demo.example.com", repository: "https://github.com/o/demo" })
  })

  test("a package.json author url is ignored while harness-kit.json sets no claude.author.url", () => {
    edit((m) => (m.author = { name: "Plugin Author", url: "not a url" }))
    generate()
    expect(pluginJson().author).toEqual({ name: "Plugin Author" })
  })

  test("once claude.author.url is set, the package.json author url wins over it and the config author is not merged in", () => {
    config.claude = { strict: true, author: { name: "Fixture Owner", url: "https://example.com/owner" } }
    edit((m) => (m.author = { name: "Plugin Author", url: "https://example.com/plugin-author" }))
    generate()
    expect(pluginJson().author).toEqual({ name: "Plugin Author", url: "https://example.com/plugin-author" })
  })

  test("inventory.json excludes populated claude settings", () => {
    edit((m) => (m["agent-plugins"].claude = { dependencies: ["a"], homepage: "https://example.com", repository: "https://github.com/o/r" }))
    generate()
    expect(readJson("inventory.json").plugins[0]).not.toHaveProperty("claude")
  })

  test("claude.dependencies are copied into plugin.json as strings and objects, in order", () => {
    const dependencies = ["audit-logger", "tools@shared-market", { name: "secrets-vault", version: "~2.1.0" }, { name: "x", marketplace: "shared-market" }]
    edit((m) => (m["agent-plugins"].claude = { dependencies }))
    generate()
    expect(pluginJson().dependencies).toEqual(dependencies)
    expect(entry()).not.toHaveProperty("dependencies")
  })

  test.each([
    ["dependencies that are not a list", { dependencies: "a" }, /claude\.dependencies/],
    ["an empty dependencies list", { dependencies: [] }, /claude\.dependencies/],
    ["a dependency that is a number", { dependencies: [1] }, /claude\.dependencies\[0\]/],
    ["a dependency name with spaces", { dependencies: ["a b"] }, /claude\.dependencies\[0\]/],
    ["a dependency object without a name", { dependencies: [{ version: "^1" }] }, /claude\.dependencies\[0\]\.name/],
    ["a dependency object with an unknown key", { dependencies: [{ name: "a", range: "^1" }] }, /claude\.dependencies\[0\].*range/],
    ["an empty dependency version", { dependencies: [{ name: "a", version: "" }] }, /claude\.dependencies\[0\]\.version/],
    ["a non-string dependency marketplace", { dependencies: [{ name: "a", marketplace: 3 }] }, /claude\.dependencies\[0\]\.marketplace/],
    ["a dependency listed twice", { dependencies: ["a", { name: "a" }] }, /claude\.dependencies.*"a" twice/],
    ["a homepage that is not a URL", { homepage: "example" }, /claude\.homepage/],
    ["a repository that is not http(s)", { repository: "git@github.com:o/r.git" }, /claude\.repository/],
    ["an unknown claude key", { homepages: "x" }, /claude\.homepages/],
    ["a claude value that is not an object", "x", /"agent-plugins\.claude"|claude/],
  ])("rejects %s", (_label, claude, message) => {
    edit((m) => (m["agent-plugins"].claude = claude))
    expect(() => readPlugins(root, config)).toThrow(message)
  })

  test("rejects a package.json author url that is not a URL once claude.author.url is set", () => {
    config.claude = { strict: true, author: { name: "o", url: "https://example.com/o" } }
    edit((m) => (m.author = { name: "A", url: "nope" }))
    expect(() => readPlugins(root, config)).toThrow(/author\.url/)
  })
})
