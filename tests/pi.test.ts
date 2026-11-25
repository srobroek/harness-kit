import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type Config, loadConfig } from "../src/config"
import { drift, readPlugins, render, stampVersion, write } from "../src/generate"
import { piAgent } from "../src/pi"
import { piNameProblems, piPackageProblems, validatePi } from "../src/validate-pi"
import { cleanup, fakePi, fixtureCopy } from "./helpers"

let root: string
let config: Config

const demo = (file: string) => path.join(root, "plugins", "demo", file)
const read = (file: string) => readFileSync(demo(file), "utf8")
const readJson = (file: string) => JSON.parse(read(file))
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(demo(file)), { recursive: true })
  writeFileSync(demo(file), text)
}
const editManifest = (change: (own: any) => void) => {
  const manifest = JSON.parse(read("package.json"))
  change(manifest["agent-plugins"])
  writeFileSync(demo("package.json"), JSON.stringify(manifest))
}
const generate = () => write(root, render(root, readPlugins(root, config), config), config)
const stale = () => {
  const found = drift(root, render(root, readPlugins(root, config), config), config)
  return [...found.changed, ...found.extra].map((file) => path.relative(demo(""), file)).sort()
}

beforeEach(() => {
  root = fixtureCopy()
  config = loadConfig(root)
  editManifest((own) => own.harnesses.push("pi"))
})
afterEach(cleanup)

describe("pi package.json", () => {
  test("names the package in piScope, carries the version, the pi-package keyword and only the resources the tree ships", () => {
    generate()
    expect(readJson("pi/package.json")).toEqual({
      name: "@agent-plugins/demo",
      version: "1.2.3",
      description: "Fixture plugin for the generator tests.",
      keywords: ["pi-package"],
      pi: { extensions: ["./_kit/rules.ts"], skills: ["./skills"] },
    })
    expect(stale()).toEqual([])
  })

  test("piScope sets the package scope", () => {
    config.piScope = "@mine"
    generate()
    expect(readJson("pi/package.json").name).toBe("@mine/demo")
  })

  test("hand-authored pi/extensions modules are listed before the rules loader, like OMP's", () => {
    put("pi/extensions/zeta.ts", "export default function (pi: unknown) {}\n")
    put("pi/extensions/alpha.js", "export default function (pi) {}\n")
    put("pi/extensions/notes.md", "not a module\n")
    generate()
    expect(readJson("pi/package.json").pi.extensions).toEqual(["./extensions/alpha.js", "./extensions/zeta.ts", "./_kit/rules.ts"])
    expect(JSON.parse(readFileSync(path.join(root, "inventory.json"), "utf8")).plugins[0].harnesses.pi.extensions).toEqual(["alpha", "zeta"])
  })

  test("a tree without skills, rules or extensions lists an empty extensions key, so pi does not load the package root", () => {
    rmSync(demo("common/skills"), { recursive: true })
    rmSync(demo("common/rules"), { recursive: true })
    generate()
    expect(readJson("pi/package.json").pi).toEqual({ extensions: [] })
  })

  test("a package of agents only lists an empty extensions key next to its agents", () => {
    // pi 1.6.0 with `"pi": { "subagents": { "agents": ["./agents"] } }` failed to start: Failed to load extension
    // "<tree>": Failed to load extension: Cannot find module '<tree>'. Any one of extensions, skills, prompts and themes
    // keeps pi from loading the package root as an extension.
    config.commonDirs = ["agents"]
    put("common/agents/helper.md", "---\ndescription: Helps.\ntools: read\n---\nHelp.\n")
    generate()
    expect(readJson("pi/package.json").pi).toEqual({ extensions: [], subagents: { agents: ["./agents"] } })
    expect(piPackageProblems(demo("pi"))).toEqual([])
    expect(stale()).toEqual([])
  })

  test("a tree with skills or prompts but no extension modules gets no extensions key", () => {
    rmSync(demo("common/rules"), { recursive: true })
    generate()
    expect(readJson("pi/package.json").pi).toEqual({ skills: ["./skills"] })
  })

  test("commands become prompt templates and agents become pi-subagents package agents", () => {
    config.commonDirs = [...config.commonDirs, "commands", "agents"]
    put("common/commands/hello.md", "---\ndescription: Say hello\n---\nSay hello to $1.\n")
    put("common/agents/helper.md", "---\ndescription: Helps.\ntools: read\n---\nHelp.\n")
    generate()
    expect(readJson("pi/package.json").pi).toEqual({
      extensions: ["./_kit/rules.ts"],
      skills: ["./skills"],
      prompts: ["./commands"],
      subagents: { agents: ["./agents"] },
    })
    expect(read("pi/commands/hello.md")).toBe(read("common/commands/hello.md"))
  })

  test("stamping bumps the pi version", () => {
    generate()
    stampVersion(root, "demo", "2.0.0", config)
    expect(readJson("pi/package.json").version).toBe("2.0.0")
  })
})

describe("pi package name", () => {
  const name = () => readJson("pi/package.json").name
  const second = (own: Record<string, unknown>) => {
    mkdirSync(path.join(root, "plugins", "second"), { recursive: true })
    writeFileSync(path.join(root, "plugins", "second", "package.json"), JSON.stringify({ name: "second", version: "1.0.0", "agent-plugins": { description: "Second.", category: "c", harnesses: ["pi"], ...own } }))
  }

  test("is <piScope>/<plugin name> by default", () => {
    generate()
    expect(name()).toBe("@agent-plugins/demo")
  })

  test("piPrefix goes before the plugin name", () => {
    config.piPrefix = "pi-"
    generate()
    expect(name()).toBe("@agent-plugins/pi-demo")
    expect(validatePi(root, config)).toBe(0)
  })

  test("a plugin's piName replaces the prefix and the plugin name", () => {
    config.piScope = "@srobroek"
    config.piPrefix = "pi-"
    editManifest((own) => (own.piName = "pi-external-repo-worker"))
    generate()
    expect(name()).toBe("@srobroek/pi-external-repo-worker")
    expect(JSON.parse(readFileSync(path.join(root, "inventory.json"), "utf8")).plugins[0].piName).toBe("pi-external-repo-worker")
    expect(validatePi(root, config)).toBe(0)
  })

  test("two plugins with one pi package name are an error, naming both", () => {
    second({ piName: "demo" })
    expect(() => readPlugins(root, config)).toThrow('plugins/second/package.json: pi package name "@agent-plugins/demo" is also the name of plugin "demo"; set a different "agent-plugins.piName"')
  })

  test("a piName that matches another plugin's prefixed name collides too", () => {
    config.piPrefix = "pi-"
    second({ piName: "pi-demo" })
    expect(() => readPlugins(root, config)).toThrow(/pi package name "@agent-plugins\/pi-demo" is also the name of plugin "demo"/)
  })

  test.each([
    ["capitals", "Pi-Demo"],
    ["a scope", "@srobroek/pi-demo"],
    ["a leading dot", ".pi-demo"],
    ["a space", "pi demo"],
  ])("a piName with %s is an error", (_label, piName) => {
    editManifest((own) => (own.piName = piName))
    expect(() => readPlugins(root, config)).toThrow(/plugins\/demo\/package\.json: "agent-plugins\.piName" must be an npm package name without a scope/)
  })

  test("a name longer than npm allows is an error", () => {
    editManifest((own) => (own.piName = "p".repeat(200)))
    expect(() => readPlugins(root, config)).toThrow(/is longer than npm's 214 characters/)
  })

  test("validate-pi reports a package name that differs from the settings", () => {
    generate()
    config.piPrefix = "pi-"
    expect(piNameProblems(demo("pi"), readPlugins(root, config)[0] as never, config)).toEqual([
      'package.json: "name" is "@agent-plugins/demo", but the plugin\'s pi package is "@agent-plugins/pi-demo" ("piScope", then "piName" or "piPrefix" and the plugin name); run harness-kit build',
    ])
    expect(validatePi(root, config)).toBe(1)
  })
})

describe("pi tree content", () => {
  test("skills and templates are copied byte for byte", () => {
    generate()
    for (const file of ["skills/demo-skill/SKILL.md", "templates/demo-template.md"]) expect(read(`pi/${file}`)).toBe(read(`common/${file}`))
  })

  test("a rule without front matter gets alwaysApply, as in OMP; a rule with front matter is copied unchanged", () => {
    put("common/rules/own.md", "---\ndescription: on demand\n---\nBody\n")
    generate()
    expect(read("pi/rules/demo-rule.md")).toBe(`---\nalwaysApply: true\n---\n\n${read("common/rules/demo-rule.md")}`)
    expect(read("pi/rules/own.md")).toBe("---\ndescription: on demand\n---\nBody\n")
  })

  test("the rules loader is vendored with a generated-by header, and goes away with the last rule", () => {
    generate()
    const source = readFileSync(path.join(import.meta.dir, "..", "runtime", "pi", "rules.ts"), "utf8")
    expect(read("pi/_kit/rules.ts")).toBe(`// Generated by scripts/build.ts. Do not edit.\n${source}`)
    rmSync(demo("common/rules"), { recursive: true })
    expect(stale().filter((file) => file.startsWith("pi/"))).toEqual(["pi/_kit/rules.ts", "pi/package.json", "pi/rules/demo-rule.md"])
    generate()
    expect(existsSync(demo("pi/_kit"))).toBe(false)
    expect(stale()).toEqual([])
  })

  test("a pi tree the plugin does not list is an error", () => {
    generate()
    editManifest((own) => (own.harnesses = ["opencode", "claude", "omp"]))
    expect(() => readPlugins(root, config)).toThrow(/plugins\/demo\/pi.*"pi" is not in harnesses/)
  })

  test("x.pi.md replaces x.md in the pi tree only", () => {
    put("common/rules/demo-rule.pi.md", "---\nalwaysApply: true\n---\npi wording\n")
    generate()
    expect(read("pi/rules/demo-rule.md")).toBe("---\nalwaysApply: true\n---\npi wording\n")
    expect(read("claude/rules/demo-rule.md")).toBe(read("common/rules/demo-rule.md"))
  })

  test("the plugin INVENTORY.md gets a pi column", () => {
    generate()
    expect(read("INVENTORY.md")).toContain("| Kind | opencode | claude | omp | pi |")
    expect(read("INVENTORY.md")).toContain("| rules | demo-rule | demo-rule | demo-rule | demo-rule |")
  })
})

describe("the vendored rules loader", () => {
  const load = async () => {
    const vendored = (await import(demo("pi/_kit/rules.ts"))) as typeof import("../runtime/pi/rules.ts")
    const pi = fakePi()
    vendored.default(pi.api)
    return { pi, vendored }
  }

  test("one section per package: always-on rules in full, the others indexed with globs and absolute path, the same text on every run", async () => {
    put("common/rules/on-demand.md", "---\ndescription: Read before editing fixtures.\n---\nOn-demand body.\n")
    put("common/rules/go-style.md", "---\ndescription: Go style.\nglobs: '*.go'\n---\nWrap errors with %w.\n")
    generate()
    expect(read("pi/rules/go-style.md")).toBe(read("common/rules/go-style.md"))
    const { pi, vendored } = await load()
    // The loader finds rules/ from its own location, which the OS reports with symlinks resolved.
    const rule = (name: string) => realpathSync(demo(`pi/rules/${name}.md`))
    const sections = pi.sections()
    expect(sections).toEqual({
      [vendored.sectionName(readJson("pi/package.json").name)]: [
        "## Rule: demo-rule\n\n# Demo rule\n\nKeep fixtures tiny.",
        "## Rules to read on demand",
        "Read a rule's file before work that its description covers.",
        `- go-style (*.go): Go style. (${rule("go-style")})\n- on-demand: Read before editing fixtures. (${rule("on-demand")})`,
      ].join("\n\n"),
    })
    expect(pi.sections()).toEqual(sections)
    expect(pi.emit("tool_call", { toolName: "read", toolCallId: "1", input: { path: "main.go" } })).toEqual([undefined])
    expect(pi.emit("tool_result", { toolCallId: "1", content: [] })[0].content[0].text).toBe("This call's file falls under the rule below.\n\n## Rule: go-style\n\nWrap errors with %w.")
  })

  test("enforces a triggered rule from the generated tree: the first matching bash call is blocked with the rule", async () => {
    put("common/rules/no-frobnicate.md", '---\ndescription: Never frobnicate.\ncondition: ["\\\\bfrobnicate-edit\\\\b"]\nscope: "tool:bash"\ninterruptMode: always\n---\nUse frobnicate-set instead.\n')
    generate()
    const { pi } = await load()
    const call = { toolName: "bash", toolCallId: "1", input: { command: "frobnicate-edit x" } }
    const [blocked] = pi.emit("tool_call", call)
    expect(blocked.block).toBe(true)
    expect(blocked.reason).toContain("## Rule: no-frobnicate\n\nUse frobnicate-set instead.")
    expect(pi.emit("tool_call", { ...call, toolCallId: "2" })).toEqual([undefined])
  })
})

describe("pi agents", () => {
  beforeEach(() => {
    config.commonDirs = [...config.commonDirs, "agents"]
  })

  const OPENCODE_AGENT = [
    "---",
    "description: Reviews a diff.",
    "mode: subagent",
    'model: "amazon-bedrock/x#medium"',
    "request:",
    "  headers:",
    "    x-opencode-model-role: standard",
    "permissions:",
    '  - action: "*"',
    '    resource: "*"',
    "    effect: deny",
    "---",
    "",
    "You review code.",
    "",
  ].join("\n")
  const OMP_AGENT = [
    "---",
    "# Generated elsewhere.",
    "name: reviewer",
    'description: "Reviews a diff."',
    "tools: read, grep, glob, lsp, bash, task",
    'spawns: "scout, operator"',
    'model: "@slow"',
    "---",
    "",
    "You review code.",
    "",
  ].join("\n")

  test("an agent with an OMP variant is translated from it: tools mapped, spawns as allowedAgents, model dropped", () => {
    put("common/agents/reviewer.md", OPENCODE_AGENT)
    put("common/agents/reviewer.omp.md", OMP_AGENT)
    generate()
    expect(read("pi/agents/reviewer.md")).toBe(
      [
        "---",
        "# Generated by scripts/build.ts from plugins/demo/common/agents/reviewer.omp.md. Do not edit.",
        '# pi-subagents takes the model from subagents.agentOverrides.reviewer.model; dropped: model "@slow"',
        "# Tools pi has no counterpart for, dropped: lsp",
        "name: reviewer",
        'description: "Reviews a diff."',
        "tools: read, ls, grep, find, bash, subagent",
        "allowedAgents: scout, operator",
        "---",
        "",
        "You review code.",
        "",
      ].join("\n"),
    )
    expect(read("omp/agents/reviewer.md")).toBe(OMP_AGENT)
    expect(read("opencode/agents/reviewer.md")).toBe(OPENCODE_AGENT)
    expect(stale()).toEqual([])
  })

  test("an OpenCode agent with only permissions fails the build, naming the file and the variants that fix it", () => {
    put("common/agents/reviewer.md", OPENCODE_AGENT)
    expect(() => generate()).toThrow(
      "plugins/demo/common/agents/reviewer.md: has no tools list for pi, and pi-subagents gives an agent without one every default tool. Add reviewer.pi.md, or an OMP variant reviewer.omp.md that lists tools",
    )
  })

  test("an OMP variant without tools fails the build too", () => {
    put("common/agents/reviewer.md", OPENCODE_AGENT)
    put("common/agents/reviewer.omp.md", "---\nname: reviewer\ndescription: Reviews.\n---\nBody\n")
    expect(() => generate()).toThrow(/plugins\/demo\/common\/agents\/reviewer\.omp\.md: has no tools list for pi/)
  })

  test("an x.pi.md variant fixes it: the agent is copied as is", () => {
    put("common/agents/reviewer.md", OPENCODE_AGENT)
    put("common/agents/reviewer.pi.md", "---\nname: reviewer\ndescription: Reviews.\ntools: read, grep\n---\nBody\n")
    generate()
    expect(read("pi/agents/reviewer.md")).toBe("---\nname: reviewer\ndescription: Reviews.\ntools: read, grep\n---\nBody\n")
  })

  test("a list whose every tool drops builds, as an explicit empty allowlist: pi-subagents gives that agent no tools", () => {
    // pi-subagents 0.90.0 reads `tools: ""` as `tools: []` (agents.js parseUnquotedList), and a defined list is an
    // explicit allowlist (child-tool-plan.js `input.tools !== undefined`), so the child gets no tools, not the defaults.
    put("common/agents/reviewer.md", OPENCODE_AGENT)
    put("common/agents/reviewer.omp.md", "---\nname: reviewer\ndescription: Reviews.\ntools: lsp, ast_grep\n---\nBody\n")
    generate()
    expect(read("pi/agents/reviewer.md")).toContain('\ntools: ""\n')
    expect(read("pi/agents/reviewer.md")).toContain("# Tools pi has no counterpart for, dropped: lsp, ast_grep\n")
  })

  test("an x.pi.md agent is copied as is, and chains and other files are copied unchanged", () => {
    const own = "---\nname: custom\ndescription: Mine.\nthinking: high\n---\nBody\n"
    put("common/agents/custom.pi.md", own)
    put("common/agents/flow.chain.md", "---\nname: flow\ndescription: A chain.\n---\n## scout\nLook.\n")
    put("common/agents/roles.json", '{"a":1}\n')
    generate()
    expect(read("pi/agents/custom.md")).toBe(own)
    expect(existsSync(demo("omp/agents/custom.md"))).toBe(false)
    expect(read("pi/agents/flow.chain.md")).toBe(read("common/agents/flow.chain.md"))
    expect(read("pi/agents/roles.json")).toBe('{"a":1}\n')
  })

  test("a shared agent is translated from the shared file", () => {
    mkdirSync(path.join(root, "shared", "agents"), { recursive: true })
    writeFileSync(path.join(root, "shared", "agents", "challenger.md"), "---\nname: challenger\ndescription: Argues.\ntools: Read\n---\nArgue.\n")
    editManifest((own) => (own.shared = ["agents/challenger"]))
    generate()
    expect(read("pi/agents/challenger.md")).toBe(
      '---\n# Generated by scripts/build.ts from shared/agents/challenger.md. Do not edit.\nname: challenger\ndescription: "Argues."\ntools: read, ls\n---\nArgue.\n',
    )
  })

  test("front matter that is not valid YAML is an error naming the file", () => {
    put("common/agents/broken.md", "---\ndescription: [unclosed\n---\nBody\n")
    expect(() => generate()).toThrow(/plugins\/demo\/common\/agents\/broken\.md: front matter is not valid YAML/)
  })
})

describe("piAgent", () => {
  const source = { name: "file-name", from: "x/agents/file-name.md", generatedBy: "gen" }

  test("a file without front matter has no tools list, so it is refused", () => {
    expect(() => piAgent("Just a prompt.\n", source)).toThrow("x/agents/file-name.md: has no tools list for pi")
  })

  test("a tools value that is not a list, such as OpenCode's legacy map, is refused", () => {
    expect(() => piAgent("---\ndescription: d\ntools:\n  write: false\n---\nP\n", source)).toThrow(/has no tools list for pi.*file-name\.pi\.md.*file-name\.omp\.md/)
  })

  test("an agent without its own name is named after the file", () => {
    expect(piAgent("---\ndescription: d\ntools: bash\n---\nP\n", source)).toBe(
      '---\n# Generated by gen from x/agents/file-name.md. Do not edit.\nname: file-name\ndescription: "d"\ntools: bash\n---\nP\n',
    )
  })

  test("Claude Code tool names map case-insensitively; spawns * adds no allowedAgents", () => {
    const text = piAgent('---\nname: c\ndescription: d\ntools: [Read, Grep, Glob, Bash, WebFetch]\nspawns: "*"\n---\nP\n', source)
    expect(text).toContain("tools: read, ls, grep, find, bash\n")
    expect(text).toContain("# Tools pi has no counterpart for, dropped: WebFetch\n")
    expect(text).not.toContain("allowedAgents")
  })

  test("a tools list with nothing pi has stays a restriction: an empty list, not pi's defaults", () => {
    expect(piAgent("---\nname: c\ndescription: d\ntools: lsp, ast_grep\n---\nP\n", source)).toContain('tools: ""\n')
  })

  test("a description with quotes stays one JSON-quoted scalar", () => {
    expect(piAgent('---\ndescription: Say "hi", then stop.\ntools: read\n---\nP\n', source)).toContain('description: "Say \\"hi\\", then stop."\n')
  })
})

describe("validate-pi", () => {
  const problems = () => piPackageProblems(demo("pi"))

  test("a generated pi package has no problems", () => {
    config.commonDirs = [...config.commonDirs, "agents", "commands"]
    put("common/agents/helper.md", "---\ndescription: Helps.\ntools: read\n---\nHelp.\n")
    put("common/commands/hello.md", "Say hello.\n")
    put("pi/extensions/ext.ts", "export default function (pi: unknown): void {}\n")
    generate()
    expect(problems()).toEqual([])
    expect(validatePi(root, config)).toBe(0)
  })

  test.each([
    ["package.json that is not JSON", () => put("pi/package.json", "{ nope"), /package\.json: not valid JSON/],
    ["a missing pi-package keyword", () => put("pi/package.json", JSON.stringify({ name: "a", version: "1.0.0", pi: {} })), /"keywords" must include "pi-package"/],
    ["a listed path that does not exist", () => put("pi/package.json", JSON.stringify({ name: "a", version: "1.0.0", keywords: ["pi-package"], pi: { skills: ["./nope"] } })), /"pi\.skills" entry "\.\/nope" does not exist/],
    ["a skill directory without SKILL.md", () => put("pi/skills/empty/notes.md", "x\n"), /skills\/empty: has no SKILL\.md/],
    ["a skill without a description", () => put("pi/skills/demo-skill/SKILL.md", "---\nname: demo-skill\n---\nBody\n"), /skills\/demo-skill\/SKILL\.md: needs a description/],
    ["an extension that does not parse", () => put("pi/_kit/rules.ts", "export default (\n"), /_kit\/rules\.ts: does not parse/],
    ["an extension without a default export", () => put("pi/_kit/rules.ts", "export const x = 1\n"), /_kit\/rules\.ts: has no default export/],
  ])("reports %s", (_label, breakIt, message) => {
    generate()
    breakIt()
    expect(problems().join("\n")).toMatch(message)
    expect(validatePi(root, config)).toBe(1)
  })

  test.each([
    ["no description", "---\nname: helper\n---\nHelp.\n", /agents\/helper\.md: needs description/],
    ["front matter that is not YAML", "---\nname: [x\n---\nHelp.\n", /agents\/helper\.md: front matter is not valid YAML/],
    ["no front matter", "Help.\n", /agents\/helper\.md: has no front matter/],
  ])("reports an agent with %s", (_label, text, message) => {
    config.commonDirs = [...config.commonDirs, "agents"]
    put("common/agents/helper.md", "---\ndescription: Helps.\ntools: read\n---\nHelp.\n")
    generate()
    put("pi/agents/helper.md", text)
    expect(problems().join("\n")).toMatch(message)
  })

  test("reports a path outside the package", () => {
    generate()
    put("pi/package.json", JSON.stringify({ name: "a", version: "1.0.0", keywords: ["pi-package"], pi: { prompts: ["../common"] } }))
    expect(problems()).toEqual(['package.json: "pi.prompts" entry "../common" is outside the package'])
  })

  test("has nothing to do when the repo does not enable pi or has no pi tree", () => {
    expect(validatePi(root, { ...config, harnesses: ["opencode", "claude", "omp"] })).toBe(0)
    expect(validatePi(root, config)).toBe(0)
  })
})
