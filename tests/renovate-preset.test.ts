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

type Rule = {
  matchUpdateTypes?: string[]
  matchCurrentVersion?: string
  matchPackageNames?: string[]
  automerge?: boolean
  enabled?: boolean
  labels?: string[]
  groupName?: string
}
const rules = preset.packageRules as Rule[]
const ruleFor = (updateType: string, automerge: boolean) =>
  rules.find((r) => r.matchUpdateTypes?.includes(updateType) && r.automerge === automerge)

describe("renovate preset: automerge", () => {
  test("Renovate merges itself, and only after the status checks pass", () => {
    // platformAutomerge would merge without CI while no required-checks ruleset is active.
    expect(preset).toMatchObject({ automerge: false, automergeType: "pr", platformAutomerge: false, ignoreTests: false, internalChecksFilter: "strict" })
  })

  test("patch updates automerge, except for 0.x packages", () => {
    const rule = ruleFor("patch", true)
    expect(rule?.matchUpdateTypes).toEqual(["patch"])
    const zeroX = new RegExp((rule?.matchCurrentVersion ?? "").replace(/^!\/|\/$/g, ""))
    expect(zeroX.test("0.9.3")).toBe(true) // the negated pattern matches 0.x, so the rule skips it
    expect(zeroX.test("1.0.3")).toBe(false)
    expect(rule?.matchCurrentVersion?.startsWith("!/")).toBe(true)
  })

  test("digest and pin updates automerge", () => {
    expect(ruleFor("digest", true)?.matchUpdateTypes).toEqual(["digest", "pin", "pinDigest"])
  })

  test("minor updates are not automerged", () => {
    expect(rules.filter((r) => r.matchUpdateTypes?.includes("minor") && r.automerge)).toEqual([])
  })

  test("a major update has its own labelled PR and never automerges", () => {
    const rule = ruleFor("major", false)
    expect(rule?.labels).toContain("major")
    expect(rule?.groupName).toBeUndefined()
  })

  test("the last rule that sets automerge turns it off for the harness-kit packages and @opencode/*", () => {
    const last = [...rules].reverse().find((r) => r.automerge !== undefined)
    expect(last).toMatchObject({ automerge: false })
    expect(last?.matchPackageNames).toEqual(["@srobroek/harness-kit", "srobroek/harness-kit", "@opencode/**"])
  })

  test("the host modules are disabled, so the host catalog sets their versions", () => {
    const rule = rules.find((r) => r.enabled === false)
    expect(rule?.matchPackageNames).toEqual(["@opentui/**", "solid-js"])
  })

  test("security fixes are labelled and, being patch or minor, not forced to automerge", () => {
    // vulnerabilityAlerts is applied as a forced override that no packageRule can veto;
    // setting automerge there would also automerge a major security fix.
    expect(preset.vulnerabilityAlerts).toEqual({ labels: ["dependencies", "security"] })
  })
})
