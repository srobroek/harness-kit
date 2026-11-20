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
})
