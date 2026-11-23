import { describe, expect, test } from "bun:test"
import releaseDefault, { releaseConfig } from "../release.config.js"

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
})
