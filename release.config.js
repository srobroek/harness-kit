// Shared semantic-release preset for plugin repos, for use with multi-semantic-release.
//
// release.config.mjs in the consumer:
//   import { releaseConfig } from "@srobroek/harness-kit/release.config.js"
//   export default releaseConfig({ forge: ["@semantic-release/gitlab", { gitlabUrl: "https://gitlab.example.com" }] })
//
// The forge plugin (GitLab, GitHub) belongs to the consumer, so it is a required argument of the function form.
// releaseRules (commit-analyzer rules) change which commit types cut a release:
//   releaseConfig({ releaseRules: [{ breaking: true, release: "major" }, { type: "refactor", release: "patch" }, { type: "docs", release: "patch" }] })
// Keep the breaking rule: a commit that matches any rule skips the defaults, so "refactor!:" would otherwise cut only a patch.
// multi-semantic-release merges a package's own release config over this one with Object.assign, so a package that needs other rules
// carries its own release.config.mjs that calls releaseConfig again; the whole config is replaced, not just the rules.
// publishPi publishes each plugin's pi/ tree to npm once the release commit is pushed:
//   releaseConfig({ forge: ["@semantic-release/github"], publishPi: true })
// It runs the npm CLI, which authenticates through npm trusted publishing (OIDC): npm 11.5.1 or later and the
// `id-token: write` permission, no token. The reusable release.yml sets that up with `npm-publish: true`.
// The consumer installs semantic-release and the plugins used here as devDependencies.

/** Publishes the plugin's pi tree; a plugin without one has nothing to publish. @semantic-release/exec ignores npm's non-JSON stdout. */
export const PUBLISH_PI_CMD = "if [ -d pi ]; then npm publish ./pi --provenance --access public; fi"

/**
 * @param {{ forge?: string | [string, object], branches?: string[], assets?: string[], releaseRules?: object[], publishPi?: boolean }} [options]
 *   forge: the plugin that publishes the release on the host; omitted, no release is published.
 *   assets: files, relative to the plugin directory, that the release commit includes.
 *   releaseRules: @semantic-release/commit-analyzer `releaseRules`, a list of { type, scope, breaking, release, ... }; omitted, the preset's defaults apply.
 *   publishPi: publish the plugin's pi/ tree to npm after the release commit (harness-kit.json needs `"pi": { "publish": true }`).
 */
export function releaseConfig({ forge, branches = ["main"], assets, releaseRules, publishPi = false } = {}) {
  if (releaseRules !== undefined && !Array.isArray(releaseRules)) throw new TypeError("releaseConfig: releaseRules must be an array of commit-analyzer rules")
  if (typeof publishPi !== "boolean") throw new TypeError("releaseConfig: publishPi must be true or false")
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
          // The publish step runs after every prepare step, so after the stamp and the pushed release commit.
          ...(publishPi ? { publishCmd: PUBLISH_PI_CMD } : {}),
        },
      ],
      [
        "@semantic-release/git",
        {
          assets: assets ?? ["CHANGELOG.md", "package.json", "INVENTORY.md", "opencode/**", "claude/**", "omp/**", "pi/**"],
          message: "chore(release): ${nextRelease.gitTag} [skip ci]\n\n${nextRelease.notes}",
        },
      ],
      ...(forge ? [forge] : []),
    ],
  }
}

export default releaseConfig()
