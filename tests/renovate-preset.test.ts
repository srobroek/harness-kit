import { describe, expect, test } from "bun:test"
import preset from "../default.json"

type Manager = { customType: string; managerFilePatterns: string[]; matchStrings: string[]; datasourceTemplate: string; versioningTemplate: string }
const managers = preset.customManagers as Manager[]
const byDatasource = (name: string): Manager => {
  const found = managers.find((m) => m.datasourceTemplate === name)
  if (!found) throw new Error(`no custom manager for ${name}`)
  return found
}
const workflowRefs = byDatasource("github-tags")
const packageVersions = byDatasource("npm")

// Renovate's (?<name>...) groups are valid JS; Renovate also scans each file with the global flag.
const capture = (manager: Manager, text: string) =>
  manager.matchStrings.flatMap((source) => [...text.matchAll(new RegExp(source, "g"))].map((match) => ({ ...match.groups })))

describe("renovate preset: Markdown managers", () => {
  test("both managers scan Markdown, with the datasource of what they match", () => {
    expect(managers).toHaveLength(2)
    for (const manager of managers) {
      expect(manager.customType).toBe("regex")
      expect(manager.managerFilePatterns).toEqual(["**/*.md"])
      expect(manager.versioningTemplate).toBe("semver")
    }
    expect(workflowRefs.datasourceTemplate).toBe("github-tags")
    expect(packageVersions.datasourceTemplate).toBe("npm")
  })

  test("the harness-kit group takes the regex managers' updates", () => {
    const rule = preset.packageRules.find((r) => r.groupName === "harness-kit")
    expect(rule?.matchManagers).toContain("custom.regex")
    expect(rule?.matchPackageNames).toEqual(["@srobroek/harness-kit", "srobroek/harness-kit"])
  })

  test("a workflow ref yields the repo and the tag with its v", () => {
    const text = "    uses: srobroek/harness-kit/.github/workflows/check.yml@v1.4.0\n    uses: srobroek/harness-kit/.github/workflows/release.yml@v12.0.10"
    expect(capture(workflowRefs, text)).toEqual([
      { depName: "srobroek/harness-kit", currentValue: "v1.4.0" },
      { depName: "srobroek/harness-kit", currentValue: "v12.0.10" },
    ])
  })

  test.each([
    ["the placeholder", "uses: srobroek/harness-kit/.github/workflows/check.yml@vX.Y.Z"],
    ["another owner", "uses: other/harness-kit/.github/workflows/check.yml@v1.4.0"],
    ["another action", "uses: actions/checkout@v4.1.0"],
    ["a ref that is not a release tag", "uses: srobroek/harness-kit/.github/workflows/check.yml@main"],
    ["a tag without patch", "uses: srobroek/harness-kit/.github/workflows/check.yml@v1.4"],
  ])("a workflow ref is not matched: %s", (_name, line) => {
    expect(capture(workflowRefs, line)).toEqual([])
  })

  test("a package version yields the package and the bare version", () => {
    const text = 'Run `npm i @srobroek/harness-kit@1.4.0`.\n{ "devDependencies": { "@srobroek/harness-kit": "1.4.0" } }'
    expect(capture(packageVersions, text)).toEqual([
      { depName: "@srobroek/harness-kit", currentValue: "1.4.0" },
      { depName: "@srobroek/harness-kit", currentValue: "1.4.0" },
    ])
  })

  test.each([
    ["an import specifier", 'import { createFakeContext } from "@srobroek/harness-kit/testing"'],
    ["a subpath file", "extends @srobroek/harness-kit/tsconfig.base.json"],
    ["the package with no version", "npm install --save-dev @srobroek/harness-kit"],
    ["the placeholder", '{ "@srobroek/harness-kit": "X.Y.Z" }'],
    ["a range", '{ "@srobroek/harness-kit": "^1.4.0" }'],
    ["another scope", "npm i @other/harness-kit@1.4.0"],
    ["a workflow ref", "uses: srobroek/harness-kit/.github/workflows/check.yml@v1.4.0"],
    ["the commit-message form", "chore(deps): bump @srobroek/harness-kit to 1.4.0"],
  ])("a package version is not matched: %s", (_name, line) => {
    expect(capture(packageVersions, line)).toEqual([])
  })
})
