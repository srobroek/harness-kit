import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type Config, loadConfig, resolveConfig } from "../src/config"
import { drift, readPlugins, render, stampVersion, write } from "../src/generate"
import { cleanup, fixtureCopy } from "./helpers"

let root: string
let config: Config

const demo = (file: string) => path.join(root, "plugins", "demo", file)
const readJson = (file: string) => JSON.parse(readFileSync(demo(file), "utf8"))
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const editManifest = (change: (manifest: any) => void) => {
  const manifest = JSON.parse(readFileSync(demo("package.json"), "utf8"))
  change(manifest)
  writeFileSync(demo("package.json"), JSON.stringify(manifest))
}
const rootManifest = (fields: Record<string, unknown>) => put(path.join(root, "package.json"), JSON.stringify({ name: "fixture-plugins", private: true, ...fields }))
const generate = () => write(root, render(root, readPlugins(root, config), config), config)
const stale = () => {
  const found = drift(root, render(root, readPlugins(root, config), config), config)
  return [...found.changed, ...found.extra].map((file) => path.relative(root, file)).sort()
}

const REPO = {
  license: "Apache-2.0",
  repository: { type: "git", url: "git+https://github.com/srobroek/harness-plugins.git" },
  homepage: "https://github.com/srobroek/harness-plugins#readme",
  bugs: { url: "https://github.com/srobroek/harness-plugins/issues" },
}

beforeEach(() => {
  root = fixtureCopy()
  config = loadConfig(root)
  editManifest((manifest) => manifest["agent-plugins"].harnesses.push("pi"))
  rootManifest(REPO)
  put(demo("README.md"), "# demo\n\nThe demo plugin.\n")
  put(demo("CHANGELOG.md"), "## 1.2.3\n\n- First.\n")
  put(path.join(root, "LICENSE"), "Apache License\n")
})
afterEach(cleanup)

describe("pi.publish off", () => {
  test("the pi package.json and tree stay as before, whatever the root package.json holds", () => {
    generate()
    expect(readJson("pi/package.json")).toEqual({
      name: "@agent-plugins/demo",
      version: "1.2.3",
      description: "Fixture plugin for the generator tests.",
      keywords: ["pi-package"],
      pi: { extensions: ["./_kit/rules.ts"], skills: ["./skills"] },
    })
    for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) expect(existsSync(demo(`pi/${file}`))).toBe(false)
  })

  test("needs no root package.json", () => {
    rmSync(path.join(root, "package.json"))
    generate()
    expect(stale()).toEqual([])
  })
})

describe("pi.publish on", () => {
  beforeEach(() => {
    config = { ...config, pi: { publish: true } }
  })

  test("the pi package.json carries the npm fields, and files lists exactly the entries the tree ships", () => {
    put(demo("pi/extensions/gate.ts"), 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"\nimport { Compile } from "typebox/compile"\nimport { helper } from "./lib/helper.ts"\nexport default function (pi: ExtensionAPI) {}\n')
    put(demo("pi/extensions/lib/helper.ts"), 'import { Text } from "@earendil-works/pi-tui"\nexport const helper = Text\n')
    generate()
    expect(readJson("pi/package.json")).toEqual({
      name: "@agent-plugins/demo",
      version: "1.2.3",
      description: "Fixture plugin for the generator tests.",
      keywords: ["pi-package"],
      license: "Apache-2.0",
      repository: { type: "git", url: "git+https://github.com/srobroek/harness-plugins.git", directory: "plugins/demo/pi" },
      homepage: "https://github.com/srobroek/harness-plugins#readme",
      bugs: { url: "https://github.com/srobroek/harness-plugins/issues" },
      files: ["CHANGELOG.md", "LICENSE", "README.md", "_kit", "extensions", "options.json", "rules", "skills", "templates"],
      publishConfig: { access: "public", provenance: true },
      peerDependencies: { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*", typebox: "*" },
      pi: { extensions: ["./extensions/gate.ts", "./_kit/rules.ts"], skills: ["./skills"] },
    })
    expect(readJson("pi/package.json")).not.toHaveProperty("private")
    expect(readJson("pi/package.json")).not.toHaveProperty("dependencies")
    expect(stale()).toEqual([])
  })

  test("files leaves out dot-entries and node_modules at the tree's root", () => {
    put(demo("pi/.DS_Store"), "x")
    put(demo("pi/node_modules/left/index.js"), "x")
    generate()
    expect(readJson("pi/package.json").files).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "_kit", "options.json", "rules", "skills", "templates"])
  })

  test("copies the plugin README and changelog and the repo LICENSE byte for byte", () => {
    generate()
    expect(readFileSync(demo("pi/README.md"), "utf8")).toBe("# demo\n\nThe demo plugin.\n")
    expect(readFileSync(demo("pi/CHANGELOG.md"), "utf8")).toBe("## 1.2.3\n\n- First.\n")
    expect(readFileSync(demo("pi/LICENSE"), "utf8")).toBe("Apache License\n")
    put(demo("README.md"), "# demo\n\nChanged.\n")
    expect(stale()).toEqual(["plugins/demo/pi/README.md"])
  })

  test("a source that goes away takes its copy and its files entry with it", () => {
    generate()
    rmSync(demo("CHANGELOG.md"))
    expect(stale()).toEqual(["plugins/demo/pi/CHANGELOG.md", "plugins/demo/pi/package.json"])
    generate()
    expect(existsSync(demo("pi/CHANGELOG.md"))).toBe(false)
    expect(readJson("pi/package.json").files).not.toContain("CHANGELOG.md")
    expect(stale()).toEqual([])
  })

  test("a package without imports of pi's host packages gets no peerDependencies", () => {
    generate()
    expect(readJson("pi/package.json")).not.toHaveProperty("peerDependencies")
  })

  test.each([
    ["a GitHub shorthand", "srobroek/harness-plugins", "git+https://github.com/srobroek/harness-plugins.git"],
    ["a github: shorthand", "github:srobroek/harness-plugins", "git+https://github.com/srobroek/harness-plugins.git"],
    ["an https URL", "https://github.com/srobroek/harness-plugins", "https://github.com/srobroek/harness-plugins"],
  ])("repository from %s, with the tree as its directory", (_label, repository, url) => {
    rootManifest({ ...REPO, repository })
    generate()
    expect(readJson("pi/package.json").repository).toEqual({ type: "git", url, directory: "plugins/demo/pi" })
  })

  test("the plugin's license wins over the repo's; homepage and bugs are left out when the root has none", () => {
    editManifest((manifest) => (manifest.license = "MPL-2.0"))
    rootManifest({ license: "Apache-2.0", repository: REPO.repository })
    generate()
    const manifest = readJson("pi/package.json")
    expect(manifest.license).toBe("MPL-2.0")
    expect(manifest).not.toHaveProperty("homepage")
    expect(manifest).not.toHaveProperty("bugs")
  })

  test("stamping bumps the published version", () => {
    generate()
    stampVersion(root, "demo", "2.0.0", config)
    expect(readJson("pi/package.json").version).toBe("2.0.0")
    expect(stale()).toEqual([])
  })

  test.each([
    ["no root package.json", () => rmSync(path.join(root, "package.json")), /^package\.json: missing; "pi\.publish" takes "repository"/],
    ["no repository", () => rootManifest({ license: "Apache-2.0" }), /^package\.json: "repository" is required when "pi\.publish" is on/],
    ["a repository that is not a URL", () => rootManifest({ ...REPO, repository: "git@github.com:o/r.git" }), /^package\.json: "repository" must be a GitHub shorthand/],
    ["no license anywhere", () => rootManifest({ repository: REPO.repository }), /^plugins\/demo\/package\.json: "license" is required when "pi\.publish" is on/],
  ])("fails with %s", (_label, breakIt, message) => {
    breakIt()
    expect(() => generate()).toThrow(message)
  })
})

describe("pi.publish in harness-kit.json", () => {
  const minimal = { marketplace: { name: "m", description: "d", owner: { name: "o" } } }

  test("defaults to off and takes true", () => {
    expect(resolveConfig(minimal).pi).toEqual({ publish: false })
    expect(resolveConfig({ ...minimal, pi: { publish: true } }).pi).toEqual({ publish: true })
  })

  test.each([
    ["a non-object", "yes", /"pi" must be an object/],
    ["a non-boolean publish", { publish: "yes" }, /"pi\.publish" must be true or false/],
    ["an unknown key", { access: "public" }, /unknown key "pi\.access"/],
  ])("rejects %s", (_label, pi, message) => {
    expect(() => resolveConfig({ ...minimal, pi })).toThrow(message)
  })
})
