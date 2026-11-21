import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { detectPackageManager, type PackageManager } from "../src/package-manager"
import { compareVersions, type Exec, update } from "../src/update"
import { cleanup, runCli, script, tempDir } from "./helpers"

afterEach(cleanup)

const NAME = "@srobroek/harness-kit"

function repo(manifest: Record<string, unknown>, lockfiles: string[] = []): string {
  const root = tempDir()
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest))
  for (const lockfile of lockfiles) writeFileSync(path.join(root, lockfile), "")
  return root
}

/** An exec stub: `bun info` and `npm view` answer `latest`; every call is recorded. */
function stub(latest: string) {
  const calls: string[] = []
  const exec: Exec = (command, args) => {
    calls.push([path.basename(command), ...args].join(" "))
    return args[0] === "info" || args[0] === "view" ? `${latest}\n` : ""
  }
  return { exec, calls }
}

describe("update", () => {
  test("reports up to date, and runs neither install nor build", () => {
    const { exec, calls } = stub("1.0.0")
    const result = update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec })
    expect(result).toEqual({ status: "current", from: "1.0.0", to: "1.0.0" })
    expect(calls).toEqual([`bun info ${NAME} version`])
  })

  test("a registry version older than the pin is not a downgrade", () => {
    const { exec, calls } = stub("0.9.0")
    expect(update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec }).status).toBe("current")
    expect(calls).toHaveLength(1)
  })

  test("adds the newer version exactly, in the field that lists it, then builds with the installed CLI", () => {
    const { exec, calls } = stub("1.2.0")
    const result = update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec })
    expect(result).toEqual({ status: "updated", from: "1.0.0", to: "1.2.0" })
    expect(calls).toEqual([`bun info ${NAME} version`, `bun add --exact --dev ${NAME}@1.2.0`, expect.stringMatching(/^harness-kit build --root /)])
  })

  test.each([
    ["dependencies", `bun add --exact ${NAME}@1.2.0`],
    ["optionalDependencies", `bun add --exact --optional ${NAME}@1.2.0`],
  ])("keeps a pin in %s in that field", (field, add) => {
    const { exec, calls } = stub("1.2.0")
    update(repo({ [field]: { [NAME]: "1.0.0" } }), { exec })
    expect(calls[1]).toBe(add)
  })

  test("a package-lock.json repo is updated with npm, in the field that lists the pin", () => {
    const { exec, calls } = stub("1.2.0")
    const root = repo({ devDependencies: { [NAME]: "1.0.0" } }, ["package-lock.json"])
    expect(update(root, { exec }).status).toBe("updated")
    expect(calls).toEqual([`npm view ${NAME} version`, `npm install --save-exact --save-dev ${NAME}@1.2.0`, expect.stringMatching(/^harness-kit build --root /)])
  })

  test.each([
    ["dependencies", `npm install --save-exact ${NAME}@1.2.0`],
    ["optionalDependencies", `npm install --save-exact --save-optional ${NAME}@1.2.0`],
  ])("npm keeps a pin in %s in that field", (field, add) => {
    const { exec, calls } = stub("1.2.0")
    update(repo({ [field]: { [NAME]: "1.0.0" } }, ["package-lock.json"]), { exec })
    expect(calls[1]).toBe(add)
  })

  test("bun.lock wins when both lockfiles exist", () => {
    const { exec, calls } = stub("1.0.0")
    update(repo({ devDependencies: { [NAME]: "1.0.0" } }, ["package-lock.json", "bun.lock"]), { exec })
    expect(calls).toEqual([`bun info ${NAME} version`])
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

  test("fails when bun info prints something that is not a version", () => {
    expect(() => update(repo({ devDependencies: { [NAME]: "1.0.0" } }), { exec: stub("garbage").exec })).toThrow(/expected a version/)
  })
})

describe("detectPackageManager", () => {
  test.each<[string[], PackageManager]>([
    [[], "bun"],
    [["bun.lock"], "bun"],
    [["bun.lockb"], "bun"],
    [["package-lock.json"], "npm"],
    [["package-lock.json", "bun.lock"], "bun"],
    [["package-lock.json", "bun.lockb"], "bun"],
  ])("lockfiles %p -> %s", (lockfiles, expected) => {
    expect(detectPackageManager(repo({}, lockfiles))).toBe(expected)
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

describe("harness-kit update (CLI, fake bun on PATH)", () => {
  // The fake bun answers `info` with $FAKE_LATEST, and `add` rewrites the pin and drops a fake harness-kit bin.
  function fakeProject(pinned: string) {
    const root = repo({ name: "consumer", devDependencies: { [NAME]: pinned } })
    writeFileSync(path.join(root, "harness-kit.json"), "{}")
    const bin = tempDir()
    script(
      path.join(bin, "bun"),
      `case "$1" in
  info) echo "$FAKE_LATEST" ;;
  add)
    sed "s/\\"$FAKE_FROM\\"/\\"$FAKE_LATEST\\"/" package.json > package.json.new && mv package.json.new package.json
    mkdir -p node_modules/.bin
    printf '#!/bin/sh\\necho built "$@" > built.txt\\n' > node_modules/.bin/harness-kit
    chmod +x node_modules/.bin/harness-kit ;;
esac`,
    )
    return { root, env: { PATH: `${bin}:${process.env.PATH}`, FAKE_LATEST: "1.1.0", FAKE_FROM: pinned } }
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
