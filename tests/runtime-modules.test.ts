import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadPrompt, loadRules, loadSkills, renderTemplate, resolveOptions } from "../runtime/opencode/content.ts"
import { isRecord, parseFrontmatter } from "../runtime/opencode/frontmatter.ts"
import { createRootResolver, rootOf } from "../runtime/opencode/session.ts"
import { agentDir, render, resolveOptions as resolveOmpOptions, templateExtension } from "../runtime/omp/template-extension.ts"
import rulesExtension, { loadRules as loadPiRules, matchesToolCall, parseRule } from "../runtime/pi/rules.ts"
import { cleanup, fakePi, tempDir } from "./helpers"

afterEach(cleanup)

function tree(files: Record<string, string>): string {
  const root = tempDir()
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

describe("frontmatter", () => {
  test("splits the block from the body and reads fields", () => {
    const parsed = parseFrontmatter("---\nname: a\ndescription:   two words  \n---\nBody\n")
    expect(parsed?.field("name")).toBe("a")
    expect(parsed?.field("description")).toBe("two words")
    expect(parsed?.field("missing")).toBeUndefined()
    expect(parsed?.body).toBe("Body\n")
  })

  test("text without a front-matter block parses to undefined", () => {
    expect(parseFrontmatter("# Just text\n")).toBeUndefined()
  })

  test.each([
    [{}, true],
    [[], false],
    [null, false],
    ["x", false],
  ])("isRecord(%p) is %p", (value, expected) => {
    expect(isRecord(value)).toBe(expected)
  })
})

describe("content loaders", () => {
  test("loadSkills returns skills by directory name order and skips ones without a name or description", () => {
    const root = tree({
      "skills/b/SKILL.md": "---\nname: b\ndescription: Second.\n---\n\nBody B\n",
      "skills/a/SKILL.md": "---\nname: a\ndescription: First.\n---\nBody A\n",
      "skills/nameless/SKILL.md": "---\ndescription: No name.\n---\nx\n",
      "skills/plain/SKILL.md": "# no front matter\n",
      "skills/empty/other.md": "x",
    })
    expect(loadSkills(root).map((skill) => [skill.id, skill.description, skill.content])).toEqual([
      ["a", "First.", "Body A"],
      ["b", "Second.", "Body B"],
    ])
  })

  test("loadRules joins the trimmed rules in name order, and is empty without a rules directory", () => {
    const root = tree({ "rules/b.md": "B\n\n", "rules/a.md": "\nA\n", "rules/skip.txt": "no" })
    expect(loadRules(root)).toBe("A\n\nB")
    expect(loadRules(tempDir())).toBe("")
  })

  test("loadPrompt puts rules before rendered templates", () => {
    const root = tree({ "rules/r.md": "Rule\n", "templates/t.md": "Say ${user_config.word}.\n" })
    expect(loadPrompt(root, { word: "hi" })).toBe("Rule\n\nSay hi.")
  })

  test("renderTemplate leaves an unknown placeholder as written", () => {
    expect(renderTemplate("${user_config.known} ${user_config.other}", { known: "k" })).toBe("k ${user_config.other}")
  })

  test("resolveOptions puts the given options over options.json and rejects unknown names and non-strings", () => {
    const root = tree({ "options.json": '{"a":"1","b":"2"}' })
    expect(resolveOptions(root, { b: "9" })).toEqual({ a: "1", b: "9" })
    expect(resolveOptions(root, undefined)).toEqual({ a: "1", b: "2" })
    expect(() => resolveOptions(root, { c: "x" })).toThrow(/unknown option "c" \(known: a, b\)/)
    expect(() => resolveOptions(root, { a: 3 })).toThrow(/must be a string/)
    expect(() => resolveOptions(root, [])).toThrow(/must be an object/)
    expect(resolveOptions(tempDir(), undefined)).toEqual({})
  })
})

describe("session roots", () => {
  const sessions = (parents: Record<string, string | null>) => async ({ sessionID }: { sessionID: string }) =>
    sessionID in parents ? { parentID: parents[sessionID] } : undefined

  test("resolve walks parentID to the root and caches the chain", async () => {
    let calls = 0
    const get = sessions({ c: "b", b: "a", a: null })
    const resolver = createRootResolver(async (input) => (calls++, get(input)))
    expect(await resolver.resolve("c")).toBe("a")
    const after = calls
    expect(await resolver.resolve("b")).toBe("a")
    expect(calls).toBe(after)
  })

  test("a marked root resolves to itself without a lookup", async () => {
    const resolver = createRootResolver(async () => {
      throw new Error("no lookup expected")
    })
    resolver.markRoot("r")
    expect(await resolver.resolve("r")).toBe("r")
  })

  test("fails closed: an unknown session, a lookup error, or a chain deeper than the limit gives undefined", async () => {
    expect(await createRootResolver(sessions({})).resolve("x")).toBeUndefined()
    expect(
      await createRootResolver(async () => {
        throw new Error("down")
      }).resolve("x"),
    ).toBeUndefined()
    const loop = sessions({ a: "b", b: "a" })
    expect(await createRootResolver(loop).resolve("a")).toBeUndefined()
  })

  test("rootOf returns the first id whose parent is not loaded", () => {
    const data: Record<string, { parentID?: string | null }> = { c: { parentID: "b" }, b: { parentID: "a" }, a: {} }
    expect(rootOf((id) => data[id], "c")).toBe("a")
    expect(rootOf((id) => data[id], "orphan")).toBe("orphan")
  })
})

describe("OMP template extension", () => {
  const install = () => tree({ "options.json": '{"word":"hello"}', "templates/note.md": "Say ${user_config.word}.\n" })
  const run = (deps: Parameters<ReturnType<typeof templateExtension>>[1]) => {
    const handlers: Array<(event: { systemPrompt: string[] }) => { systemPrompt: string[] }> = []
    templateExtension("note")({ on: (_event, handler) => void handlers.push(handler) }, deps)
    return handlers[0]!({ systemPrompt: ["base"] }).systemPrompt
  }

  test("appends the rendered template with the defaults when the user file is missing", () => {
    expect(run({ root: install(), optionsPath: "/nonexistent/note.json" })).toEqual(["base", "Say hello."])
  })

  test("the user's file overrides a default", () => {
    const user = tree({ "note.json": '{"word":"howdy"}' })
    expect(run({ root: install(), optionsPath: path.join(user, "note.json") })).toEqual(["base", "Say howdy."])
  })

  test("a bad user file is reported once and the defaults apply", () => {
    const user = tree({ "note.json": '{"nope":"x"}' })
    const warnings: string[] = []
    expect(run({ root: install(), optionsPath: path.join(user, "note.json"), warn: (m) => void warnings.push(m) })).toEqual(["base", "Say hello."])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unknown option "nope"')
  })

  test("resolveOptions names the file in its type error, and agentDir honours PI_CODING_AGENT_DIR", () => {
    expect(() => resolveOmpOptions({}, [], "note.json")).toThrow("note.json must be an object")
    expect(agentDir({ PI_CODING_AGENT_DIR: " /x/agent " })).toBe("/x/agent")
    expect(agentDir({})).toMatch(/\.omp\/agent$/)
    expect(render("${user_config.a}${user_config.b}", { a: "1" })).toBe("1${user_config.b}")
  })
})

describe("pi rules extension", () => {
  const load = (root: string, warnings: string[] = []) => {
    const pi = fakePi()
    rulesExtension(pi.api, { root, warn: (text) => void warnings.push(text) })
    return pi
  }
  const prompts = (root: string) => load(root).emit("before_agent_start", { systemPrompt: "BASE" }).map((result) => result.systemPrompt)

  test("puts an alwaysApply rule in full and another rule as an index line with its absolute path", () => {
    const root = tree({
      "rules/b-on-demand.md": "---\ndescription: 'Read before touching the API.'\n---\nOn-demand body.\n",
      "rules/a-always.md": "---\nalwaysApply: true\n---\n\nAlways keep the build green.\n",
    })
    const [prompt] = prompts(root)
    expect(prompt).toBe(
      [
        "BASE",
        "## Rule: a-always\n\nAlways keep the build green.",
        `## Rules to read on demand\n\nRead a rule's file before work that its description covers.\n\n- b-on-demand: Read before touching the API. (${path.join(root, "rules", "b-on-demand.md")})`,
      ].join("\n\n"),
    )
    expect(prompt).not.toContain("On-demand body.")
  })

  test("the text is deterministic: rules sort by file name, whatever order they were written in", () => {
    const one = tree({ "rules/z.md": "---\nalwaysApply: true\n---\nZ\n", "rules/a.md": "---\nalwaysApply: true\n---\nA\n", "rules/sub/m.md": "---\nalwaysApply: true\n---\nM\n" })
    const two = tree({ "rules/sub/m.md": "---\nalwaysApply: true\n---\nM\n", "rules/a.md": "---\nalwaysApply: true\n---\nA\n", "rules/z.md": "---\nalwaysApply: true\n---\nZ\n" })
    const [first] = prompts(one)
    expect(first).toBe("BASE\n\n## Rule: a\n\nA\n\n## Rule: sub/m\n\nM\n\n## Rule: z\n\nZ")
    expect(prompts(two)).toEqual([first as string])
    expect(prompts(one)).toEqual([first as string])
  })

  test("registers nothing without rules, and no trigger handlers without triggered rules", () => {
    expect([...load(tree({ "skills/x/SKILL.md": "x" })).handlers.keys()]).toEqual([])
    expect([...load(tree({ "rules/a.md": "---\ndescription: d\n---\nA\n" })).handlers.keys()]).toEqual(["before_agent_start"])
    expect(loadPiRules("/nonexistent/rules")).toEqual([])
  })

  test("parseRule reads alwaysApply only when it is true, and a rule without front matter is on demand", () => {
    expect(parseRule("r", "/r.md", "---\nalwaysApply: false\ndescription: \"x\"\n---\nBody\n")).toEqual({ name: "r", file: "/r.md", alwaysApply: false, description: "x", body: "Body" })
    expect(parseRule("r", "/r.md", "Plain\n")).toEqual({ name: "r", file: "/r.md", alwaysApply: false, body: "Plain" })
  })
})

describe("pi rule triggers", () => {
  const CORPUS = path.join(import.meta.dir, "fixtures", "pi-rules")
  const corpus = Object.fromEntries(loadPiRules(CORPUS).map((rule) => [rule.name, rule]))
  const rule = (front: string, body = "Rule body.") => parseRule("r", "/rules/r.md", `---\n${front}\n---\n${body}\n`)
  const load = (files: Record<string, string>, warnings: string[] = []) => {
    const root = tree(files)
    const pi = fakePi()
    rulesExtension(pi.api, { root, warn: (text) => void warnings.push(text) })
    return pi
  }
  const bash = (command: string, id = command) => ({ toolName: "bash", toolCallId: id, input: { command } })

  describe("matching", () => {
    test("a bash condition matches the command; OMP's bd edit rule skips --help and keeps tool:bash but not tool:eval", () => {
      const trigger = corpus["beads-no-editor"]?.trigger
      if (!trigger) throw new Error("beads-no-editor has no trigger")
      expect(trigger.tools).toEqual([{ tool: "bash" }])
      expect(trigger.interrupt).toBe("always")
      for (const command of ["bd edit bd-12", "EDITOR=true bd edit bd-12", "sudo bd -C /repo edit x"]) expect(matchesToolCall(trigger, "bash", { command }, "/w")).toBe(true)
      for (const command of ["bd edit --help", "bd show bd-12", "echo bd edit"]) expect(matchesToolCall(trigger, "bash", { command }, "/w")).toBe(false)
      expect(matchesToolCall(trigger, "edit", { path: "x", edits: [{ oldText: "", newText: "bd edit 1" }] }, "/w")).toBe(false)
    })

    test("a condition written for OMP's JSON arguments also matches, because bash calls are tested as their JSON too", () => {
      const trigger = rule('condition: ["\\"command\\"\\\\s*:\\\\s*\\"git push --force"]\nscope: "tool:bash"').trigger
      if (!trigger) throw new Error("no trigger")
      expect(matchesToolCall(trigger, "bash", { command: "git push --force origin" }, "/w")).toBe(true)
    })

    test("an edit glob matches the path as given, absolute, relative to the cwd and by base name; the condition tests the new text", () => {
      const trigger = rule('condition: ["as any"]\nscope: "tool:edit(**/extensions/*.ts), tool:write(*.md)"').trigger
      if (!trigger) throw new Error("no trigger")
      const edit = (file: string, newText = "x as any") => matchesToolCall(trigger, "edit", { path: file, edits: [{ oldText: "x", newText }] }, "/repo")
      expect(edit("extensions/a.ts")).toBe(true)
      expect(edit("/repo/pkg/extensions/a.ts")).toBe(true)
      expect(edit("/elsewhere/extensions/a.ts")).toBe(true)
      expect(edit("src/a.ts")).toBe(false)
      expect(edit("extensions/a.ts", "x as unknown")).toBe(false)
      expect(matchesToolCall(trigger, "write", { path: "/repo/docs/notes.md", content: "y as any" }, "/repo")).toBe(true)
      expect(matchesToolCall(trigger, "read", { path: "extensions/a.ts" }, "/repo")).toBe(false)
    })

    test("a leading (?i) becomes the i flag", () => {
      const trigger = rule('condition: "(?i)drop table"\nscope: tool:bash').trigger
      if (!trigger) throw new Error("no trigger")
      expect(matchesToolCall(trigger, "bash", { command: "psql -c 'DROP TABLE x'" }, "/w")).toBe(true)
    })

    test("the never-matching (?!) and a rule with only tools pi lacks stay index-only", () => {
      expect(corpus["srobroek-package-investigate"]?.trigger).toBeUndefined()
      expect(corpus["srobroek-package-investigate"]?.problem).toBeUndefined()
      expect(rule('condition: ["x"]\nscope: "tool:eval"').trigger).toBeUndefined()
      const pi = load({ "rules/never.md": readFileSync(path.join(CORPUS, "srobroek-package-investigate.md"), "utf8") })
      expect([...pi.handlers.keys()]).toEqual(["before_agent_start"])
      expect(pi.emit("before_agent_start", { systemPrompt: "" })[0].systemPrompt).toContain("- never: Before adding or changing a dependency")
    })

    test("an invalid regex skips the trigger, keeps the rule in the index, and warns once at load", () => {
      expect(rule('condition: ["ok", "(unclosed"]\nscope: tool:bash').problem).toMatch(/^invalid condition "\(unclosed"/)
      const warnings: string[] = []
      const pi = load({ "rules/bad.md": '---\ndescription: Bad.\ncondition: ["(unclosed"]\nscope: "tool:bash"\ninterruptMode: always\n---\nBody\n' }, warnings)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("bad.md: invalid condition")
      expect(pi.handlers.has("tool_call")).toBe(false)
      expect(pi.emit("before_agent_start", { systemPrompt: "" })[0].systemPrompt).toContain("- bad: Bad.")
    })

    test("no scope means text and every tool, not thinking", () => {
      const trigger = rule('condition: "x"').trigger
      expect({ text: trigger?.text, thinking: trigger?.thinking, tools: trigger?.tools.map((scope) => scope.tool) }).toEqual({ text: true, thinking: false, tools: ["bash", "edit", "write", "read"] })
    })
  })

  describe("tool calls", () => {
    const NO_FROB = '---\ndescription: No frobnicating.\ncondition: ["\\\\bfrobnicate-edit\\\\b"]\nscope: "tool:bash"\ninterruptMode: always\n---\nUse frobnicate-set.\n'
    const NO_ZAP = '---\ndescription: No zapping.\ncondition: ["\\\\bzap\\\\b"]\nscope: "tool:bash"\ninterruptMode: always\n---\nDo not zap.\n'

    test("interruptMode always blocks the first matching call with the rule; the identical retry and later matches of that rule run", () => {
      const pi = load({ "rules/no-frob.md": NO_FROB, "rules/no-zap.md": NO_ZAP })
      expect(pi.emit("tool_call", bash("ls"))).toEqual([undefined])
      expect(pi.emit("tool_call", bash("frobnicate-edit x", "1"))).toEqual([
        { block: true, reason: "This call was blocked before it ran, by the rule below.\n\n## Rule: no-frob\n\nUse frobnicate-set.\n\nRetry the call if it still applies." },
      ])
      expect(pi.emit("tool_call", bash("frobnicate-edit x", "2"))).toEqual([undefined])
      expect(pi.emit("tool_call", bash("frobnicate-edit y", "3"))).toEqual([undefined])
      expect(pi.emit("tool_call", bash("frobnicate-edit y && zap", "4"))[0].reason).toContain("## Rule: no-zap\n\nDo not zap.")
    })

    test("a new session starts the count again", () => {
      const pi = load({ "rules/no-frob.md": NO_FROB })
      expect(pi.emit("tool_call", bash("frobnicate-edit x", "1"))[0].block).toBe(true)
      pi.emit("session_start", {})
      expect(pi.emit("tool_call", bash("frobnicate-edit x", "2"))[0].block).toBe(true)
    })

    test("interruptMode never lets the call run and appends the rule to its result once per session", () => {
      const pi = load({ "rules/hint.md": NO_FROB.replace("interruptMode: always", "interruptMode: never") })
      const output = { type: "text", text: "done" }
      expect(pi.emit("tool_call", bash("frobnicate-edit x", "1"))).toEqual([undefined])
      expect(pi.emit("tool_result", { toolCallId: "1", content: [output] })).toEqual([
        { content: [output, { type: "text", text: "This call matched the rule below.\n\n## Rule: hint\n\nUse frobnicate-set." }] },
      ])
      expect(pi.emit("tool_call", bash("frobnicate-edit y", "2"))).toEqual([undefined])
      expect(pi.emit("tool_result", { toolCallId: "2", content: [output] })).toEqual([undefined])
    })

    test("a rule without interruptMode does not block", () => {
      const pi = load({ "rules/hint.md": NO_FROB.replace("interruptMode: always\n", "") })
      expect(pi.emit("tool_call", bash("frobnicate-edit x", "1"))).toEqual([undefined])
      expect(pi.emit("tool_result", { toolCallId: "1", content: [], structuredContent: { kept: true } })[0]).toMatchObject({ structuredContent: { kept: true } })
    })
  })

  describe("streamed text", () => {
    const delta = (type: string, text: string, contentIndex = 0) => ({ assistantMessageEvent: { type, contentIndex, delta: text } })

    test("a match across streamed deltas steers the rule in once per session, without aborting", () => {
      const pi = load({ "rules/contention.md": readFileSync(path.join(CORPUS, "beads-contention-retry.md"), "utf8") })
      pi.emit("message_start", { message: { role: "assistant" } })
      pi.emit("message_update", delta("thinking_delta", "the store says lock busy: held by "))
      expect(pi.sent).toEqual([])
      pi.emit("message_update", delta("thinking_delta", "another process, so"))
      expect(pi.sent).toHaveLength(1)
      expect(pi.sent[0]?.options).toEqual({ deliverAs: "steer" })
      expect(pi.sent[0]?.message).toMatchObject({ customType: "harness-kit-rule", display: true })
      expect(pi.sent[0]?.message.content).toStartWith("Your reasoning matched the rule below.\n\n## Rule: contention\n\nThis is contention, not a failure.")
      pi.emit("message_start", { message: { role: "assistant" } })
      pi.emit("message_update", delta("text_delta", "lock busy: held by another process"))
      expect(pi.sent).toHaveLength(1)
    })

    test("thinking is not watched unless the scope names it, and a new message starts a new buffer", () => {
      const pi = load({ "rules/t.md": '---\ncondition: "secret word"\nscope: text\n---\nBody\n' })
      pi.emit("message_start", { message: { role: "assistant" } })
      pi.emit("message_update", delta("thinking_delta", "secret word"))
      pi.emit("message_update", delta("text_delta", "secret "))
      pi.emit("message_start", { message: { role: "assistant" } })
      pi.emit("message_update", delta("text_delta", "word"))
      expect(pi.sent).toEqual([])
      pi.emit("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "the secret word" } })
      expect(pi.sent).toHaveLength(1)
    })
  })
})
