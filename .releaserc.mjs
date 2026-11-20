// harness-kit's own release: tags vX.Y.Z, publishes to npm through trusted publishing (OIDC) and creates the GitHub release.
// HARNESS_KIT_NPM_PUBLISH=false tags and releases without publishing, for the first release (npm needs a manual first publish).
export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    ["@semantic-release/npm", { npmPublish: process.env.HARNESS_KIT_NPM_PUBLISH !== "false" }],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
        message: "chore(release): ${nextRelease.gitTag} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    "@semantic-release/github",
  ],
}
