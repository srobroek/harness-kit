// Shared semantic-release preset for plugin repos, for use with multi-semantic-release.
//
// release.config.mjs in the consumer:
//   import { releaseConfig } from "@srobroek/harness-kit/release.config.js"
//   export default releaseConfig({ forge: ["@semantic-release/gitlab", { gitlabUrl: "https://gitlab.example.com" }] })
//
// The forge plugin (GitLab, GitHub) belongs to the consumer, so it is a required argument of the function form.
// releaseRules (commit-analyzer rules) change which commit types cut a release:
//   releaseConfig({ releaseRules: [{ type: "refactor", release: "patch" }, { type: "docs", release: "patch" }] })
// multi-semantic-release merges a package's own release config over this one with Object.assign, so a package that needs other rules
// carries its own release.config.mjs that calls releaseConfig again; the whole config is replaced, not just the rules.
// The consumer installs semantic-release and the plugins used here as devDependencies.

/**
 * @param {{ forge?: string | [string, object], branches?: string[], assets?: string[], releaseRules?: object[] }} [options]
 *   forge: the plugin that publishes the release on the host; omitted, no release is published.
 *   assets: files, relative to the plugin directory, that the release commit includes.
 *   releaseRules: @semantic-release/commit-analyzer `releaseRules`, a list of { type, scope, breaking, release, ... }; omitted, the preset's defaults apply.
 */
export function releaseConfig({ forge, branches = ["main"], assets, releaseRules } = {}) {
  if (releaseRules !== undefined && !Array.isArray(releaseRules)) throw new TypeError("releaseConfig: releaseRules must be an array of commit-analyzer rules")
  return {
    branches,
    plugins: [
      ["@semantic-release/commit-analyzer", { preset: "conventionalcommits", ...(releaseRules ? { releaseRules } : {}) }],
      ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
      ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
      [
        "@semantic-release/exec",
        {
          // Runs in the plugin directory. Stamps the version everywhere it appears and stages the root-level generated files.
          prepareCmd: 'harness-kit stamp "$(basename "$PWD")" ${nextRelease.version} --git-add',
        },
      ],
      [
        "@semantic-release/git",
        {
          assets: assets ?? ["CHANGELOG.md", "package.json", "INVENTORY.md", "opencode/**", "claude/**", "omp/**"],
          message: "chore(release): ${nextRelease.gitTag} [skip ci]\n\n${nextRelease.notes}",
        },
      ],
      ...(forge ? [forge] : []),
    ],
  }
}

export default releaseConfig()
