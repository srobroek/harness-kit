// The reusable workflows and the npm package are released together under the same vX.Y.Z tag.
// This finds consumer workflow references that have drifted from the pinned package version.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { pinnedVersion } from "./update"

const REF = /srobroek\/harness-kit\/\.github\/workflows\/[\w.-]+@([^\s"'#]+)/g

/** Warnings for `uses: srobroek/harness-kit/...@ref` lines whose ref is not `v<pinned package version>`. */
export function workflowRefWarnings(root: string): string[] {
  let pinned: string
  try {
    pinned = pinnedVersion(root)
  } catch {
    return [] // no package.json pin: not a consumer, nothing to compare against
  }
  const dir = path.join(root, ".github", "workflows")
  if (!existsSync(dir)) return []
  const warnings: string[] = []
  for (const name of readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const lines = readFileSync(path.join(dir, name), "utf8").split("\n")
    lines.forEach((line, index) => {
      for (const match of line.matchAll(REF)) {
        if (match[1] !== `v${pinned}`) {
          warnings.push(
            `.github/workflows/${name}:${index + 1} uses harness-kit workflow @${match[1]}, but @srobroek/harness-kit is pinned at ${pinned}; use @v${pinned}`,
          )
        }
      }
    })
  }
  return warnings
}
