import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { compareVersions, type Exec, update } from "../src/update"
import { cleanup, runCli, script, tempDir } from "./helpers"

afterEach(cleanup)

const NAME = "@srobroek/harness-kit"

function repo(manifest: Record<string, unknown>): string {
  const root = tempDir()
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest))
  return root
}

/** An exec stub: `npm view` answers `latest`; every call is recorded. */
function stub(latest: string) {
  const calls: string[] = []
  const exec: Exec = (command, args) => {
    calls.push([path.basename(command), ...args].join(" "))
    return args[0] === "view" ? `${latest}\n` : ""
  }
  return { exec, calls }
}

describe("update", () => {
  test("reports up to date, and runs neither install nor build", () => {
    const { exec, calls } = stub("1.0.0")
    const result = update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec })
    expect(result).toEqual({ status: "current", from: "1.0.0", to: "1.0.0" })
    expect(calls).toEqual([`npm view ${NAME} version`])
  })

  test("a registry version older than the pin is not a downgrade", () => {
    const { exec, calls } = stub("0.9.0")
    expect(update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec }).status).toBe("current")
    expect(calls).toHaveLength(1)
  })

  test("installs the newer version with --save-exact, then builds with the installed CLI", () => {
    const { exec, calls } = stub("1.2.0")
    const result = update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec })
    expect(result).toEqual({ status: "updated", from: "1.0.0", to: "1.2.0" })
    expect(calls).toEqual([`npm view ${NAME} version`, `npm install --save-exact ${NAME}@1.2.0`, expect.stringMatching(/^harness-kit build --root /)])
  })

  test("--check reports outdated without installing", () => {
    const { exec, calls } = stub("1.2.0")
    const result = update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec, check: true })
    expect(result).toEqual({ status: "outdated", from: "1.0.0", to: "1.2.0" })
    expect(calls).toHaveLength(1)
  })

  test.each(["dependencies", "devDependencies", "optionalDependencies"])("finds the pin in %s", (field) => {
    const { exec } = stub("1.0.1")
    expect(update(repo({ [field]: { [NAME]: "1.0.0" } }), { exec, check: true }).status).toBe("outdated")
  })

  test("a caret range counts as its base version", () => {
    const { exec } = stub("1.0.0")
    expect(update(repo({ devDependencies: { [NAME]: "^1.0.0" } }), { exec }).status).toBe("current")
  })

  test("fails clearly when the package is not a dependency", () => {
    expect(() => update(repo({ devDependencies: {} }), { exec: stub("1.0.0").exec })).toThrow(/not in dependencies/)
  })

  test("fails clearly when the pin is not a version", () => {
    expect(() => update(repo({ devDependencies: { [NAME]: "github:x/y" } }), { exec: stub("1.0.0").exec })).toThrow(/not a plain version/)
  })

  test("fails when npm view prints something that is not a version", () => {
    expect(() => update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec: stub("garbage").exec })).toThrow(/expected a version/)
  })
})

describe("compareVersions", () => {
  test.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.2.0", "1.10.0", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.0-beta.1", "1.0.0", -1],
    ["1.0.0", "1.0.0-beta.1", 1],
  ])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign)
  })
})

describe("harness-kit update (CLI, fake npm on PATH)", () => {
  // The fake npm answers `view` with $FAKE_LATEST, and `install` rewrites the pin and drops a fake harness-kit bin.
  function fakeProject(pinned: string) {
    const root = repo({ name: "consumer", devDependencies: { [NAME]: pinned } })
    writeFileSync(path.join(root, "harness-kit.json"), "{}")
    const bin = tempDir()
    script(
      path.join(bin, "npm"),
      `case "$1" in
  view) echo "$FAKE_LATEST" ;;
  install)
    sed "s/\\"$NPM_FROM\\"/\\"$FAKE_LATEST\\"/" package.json > package.json.new && mv package.json.new package.json
    mkdir -p node_modules/.bin
    printf '#!/bin/sh\\necho built "$@" > built.txt\\n' > node_modules/.bin/harness-kit
    chmod +x node_modules/.bin/harness-kit ;;
esac`,
    )
    return { root, env: { PATH: `${bin}:${process.env.PATH}`, FAKE_LATEST: "1.1.0", NPM_FROM: pinned } }
  }

  test("prints old -> new, pins the new version and rebuilds", () => {
    const { root, env } = fakeProject("1.0.0")
    const result = runCli(["update", "--root", root], { env })
    expect(result.code).toBe(0)
    expect(result.out).toContain("1.0.0 -> 1.1.0")
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).devDependencies[NAME]).toBe("1.1.0")
    expect(readFileSync(path.join(root, "built.txt"), "utf8")).toContain("build --root")
  })

  test("prints up to date and exits 0 when current", () => {
    const { root, env } = fakeProject("1.1.0")
    const result = runCli(["update", "--root", root], { env })
    expect(result.code).toBe(0)
    expect(result.out.trim()).toBe("up to date")
  })

  test("--check exits 1 when outdated and changes nothing", () => {
    const { root, env } = fakeProject("1.0.0")
    const before = readFileSync(path.join(root, "package.json"), "utf8")
    const result = runCli(["update", "--check", "--root", root], { env })
    expect(result.code).toBe(1)
    expect(result.out).toContain("1.0.0 -> 1.1.0")
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before)
  })

  test("--check exits 0 when current", () => {
    const { root, env } = fakeProject("1.1.0")
    expect(runCli(["update", "--check", "--root", root], { env }).code).toBe(0)
  })
})
