import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadPrompt, loadRules, loadSkills, renderTemplate, resolveOptions } from "../runtime/opencode/content.ts"
import { isRecord, parseFrontmatter } from "../runtime/opencode/frontmatter.ts"
import { createRootResolver, rootOf } from "../runtime/opencode/session.ts"
import { agentDir, render, resolveOptions as resolveOmpOptions, templateExtension } from "../runtime/omp/template-extension.ts"
import { cleanup, tempDir } from "./helpers"

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
