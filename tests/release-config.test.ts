import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import releaseDefault, { PUBLISH_PI_CMD, releaseConfig } from "../release.config.js"

const names = (config: ReturnType<typeof releaseConfig>) => config.plugins.map((plugin: unknown) => (Array.isArray(plugin) ? plugin[0] : plugin))

describe("release preset", () => {
  test("adds no forge plugin unless the consumer passes one", () => {
    expect(names(releaseDefault)).not.toContain("@semantic-release/gitlab")
    expect(names(releaseDefault).at(-1)).toBe("@semantic-release/git")
  })

  test("appends the consumer's forge plugin last, after the git plugin", () => {
    const config = releaseConfig({ forge: ["@semantic-release/gitlab", { gitlabUrl: "https://gitlab.example.com" }] })
    expect(config.plugins.at(-1)).toEqual(["@semantic-release/gitlab", { gitlabUrl: "https://gitlab.example.com" }])
    expect(names(config).at(-2)).toBe("@semantic-release/git")
  })

  test("prepareCmd stamps the version with harness-kit and stages the generated files", () => {
    const exec = releaseDefault.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@semantic-release/exec") as [string, { prepareCmd: string }]
    expect(exec[1].prepareCmd).toBe('harness-kit stamp "$(basename "$PWD")" ${nextRelease.version} --git-add')
  })

  test("the release commit takes every harness tree by default, pi included", () => {
    const git = releaseDefault.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git") as [string, { assets: string[] }]
    expect(git[1].assets).toEqual(["CHANGELOG.md", "package.json", "INVENTORY.md", "opencode/**", "claude/**", "omp/**", "pi/**"])
  })

  const analyzer = (config: ReturnType<typeof releaseConfig>) =>
    config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer") as [string, Record<string, unknown>]

  test("without options the commit analyzer takes only the preset", () => {
    expect(analyzer(releaseDefault)[1]).toEqual({ preset: "conventionalcommits" })
  })

  test("releaseRules are passed to the commit analyzer next to the preset", () => {
    const releaseRules = [{ type: "refactor", release: "patch" }, { type: "docs", release: "patch" }]
    expect(analyzer(releaseConfig({ releaseRules }))[1]).toEqual({ preset: "conventionalcommits", releaseRules })
  })

  test("releaseRules leave the other plugins as they were", () => {
    const rules = releaseConfig({ releaseRules: [{ breaking: true, release: "minor" }] })
    const rest = (config: ReturnType<typeof releaseConfig>) => config.plugins.filter((plugin: unknown) => !(Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer"))
    expect(rest(rules)).toEqual(rest(releaseDefault))
  })

  test.each([["a string", "rules.js"], ["an object", {}], ["null", null]])("rejects releaseRules that are %s", (_label, releaseRules) => {
    expect(() => releaseConfig({ releaseRules: releaseRules as never })).toThrow(/releaseRules/)
  })

  const exec = (config: ReturnType<typeof releaseConfig>) =>
    (config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@semantic-release/exec") as [string, Record<string, string>])[1]

  test("without publishPi nothing is published to npm", () => {
    expect(Object.keys(exec(releaseDefault))).toEqual(["prepareCmd"])
    expect(names(releaseDefault)).not.toContain("@semantic-release/npm")
  })

  test("publishPi publishes the plugin's pi tree with the npm CLI, after the stamp, with provenance and no token", () => {
    const config = releaseConfig({ forge: "@semantic-release/github", publishPi: true })
    expect(exec(config)).toEqual({ prepareCmd: exec(releaseDefault).prepareCmd as string, publishCmd: PUBLISH_PI_CMD })
    expect(PUBLISH_PI_CMD).toBe("if [ -d pi ]; then npm publish ./pi --provenance --access public; fi")
    expect(names(config)).toEqual(names(releaseConfig({ forge: "@semantic-release/github" })))
    expect(JSON.stringify(config)).not.toContain("NPM_TOKEN")
  })

  test.each([["a string", "yes"], ["null", null]])("rejects publishPi that is %s", (_label, publishPi) => {
    expect(() => releaseConfig({ publishPi: publishPi as never })).toThrow(/publishPi must be true or false/)
  })
})

describe("reusable release workflow", () => {
  const workflow = Bun.YAML.parse(readFileSync(path.join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8")) as any
  const steps = workflow.jobs.release.steps as Array<Record<string, any>>

  test("npm-publish is an opt-in boolean input", () => {
    expect(workflow.on.workflow_call.inputs["npm-publish"]).toMatchObject({ type: "boolean", default: false })
  })

  test("with npm-publish, setup-node points at the npm registry and npm is upgraded for trusted publishing; no token is passed", () => {
    const node = steps.find((step) => String(step.uses).startsWith("actions/setup-node@"))
    expect(node?.with["registry-url"]).toBe("${{ inputs.npm-publish && 'https://registry.npmjs.org' || '' }}")
    expect(steps.find((step) => step.run === "npm install --global npm@^11.5.1")?.if).toBe("${{ inputs.npm-publish }}")
    expect(JSON.stringify(workflow)).not.toContain("NPM_TOKEN")
  })

  test("asks for no permissions itself, so a caller that grants no id-token keeps working", () => {
    expect(workflow.permissions).toBeUndefined()
    expect(workflow.jobs.release.permissions).toBeUndefined()
  })
})
