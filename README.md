# harness-kit

Shared build tooling for repos that ship agent plugins to OpenCode, Claude Code and OMP. A plugin repo keeps its plugins in `plugins/<name>/`; harness-kit generates the per-harness manifests, marketplaces, copies of shared content and inventories from them, and checks that the generated files are current.

The package is `@srobroek/harness-kit`. It ships TypeScript source that runs under [bun](https://bun.sh), with no build step.

## Install

Pin the exact version, as a dev dependency:

```sh
npm install --save-dev --save-exact @srobroek/harness-kit
```

```json
{ "devDependencies": { "@srobroek/harness-kit": "1.0.0" } }
```

bun must be on `PATH`, because the `harness-kit` bin has a bun shebang. `npm ci` and `bun install` both install it.

## Config

`harness-kit.json` sits at the repo root. The CLI finds it by walking up from the current directory, or takes `--root <dir>`. An unknown key or a bad value fails with an error that names the field.

```json
{
  "marketplace": {
    "name": "my-plugins",
    "description": "Agent plugins for OpenCode, Claude Code and OMP.",
    "owner": { "name": "Your Name" }
  },
  "harnesses": ["opencode", "claude", "omp"],
  "commonDirs": ["skills", "rules"],
  "kinds": ["skills", "agents", "commands", "rules", "hooks", "tools", "extensions", "mcp"],
  "claude": { "strict": true }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `marketplace.name`, `.description`, `.owner.name` | required | Written to the Claude and OMP marketplace files. |
| `harnesses` | all three | Harnesses the repo targets. A plugin may list only these. Claude and OMP each get a marketplace file; OpenCode has none. |
| `commonDirs` | `skills`, `rules` | Directories under `plugins/<name>/common/` copied into each harness tree. Add `templates`, `scripts` or `formulas` as needed. |
| `kinds` | the eight kinds without `templates` and `styles` | Rows of the inventory tables and keys of `inventory.json`. Any of `skills agents commands rules templates styles hooks tools extensions mcp`. |
| `pluginKey` | `agent-plugins` | Key in each plugin's `package.json` that holds its settings. |
| `ompScope` | `@agent-plugins` | npm scope of the generated OMP package name. |
| `generatedBy` | `harness-kit build` | Names the generator in the note at the top of generated Markdown. |
| `claude.strict` | `true` | `validate-claude` passes `--strict` to `claude plugin validate`. |
| `claude.author`, `claude.license` | none | Written to a Claude manifest whose `package.json` sets no `author` or `license`. |
| `omp.packageType` | none | `"module"` or `"commonjs"`: adds `type` to the generated OMP `package.json`. |

### Plugin settings

Each plugin's `package.json` carries `name` (equal to the directory), `version`, and the `agent-plugins` key (or your `pluginKey`) with `description`, `category`, `harnesses`, and optionally `scope`, `discrepancies`, `claudeName`, `options` or `userConfig`. Standard `author` and `license` fields go into the Claude manifest.

- `claudeName` renames the plugin in Claude's manifest and marketplace, which sets the `/<name>:<command>` namespace.
- `options` (name to `{ description, default }`) become a Claude `userConfig` and an `options.json` in every harness tree.
- `userConfig` is copied into the Claude manifest as is. Setting both `options` and `userConfig` is an error.
- `common/<dir>/x.<harness>.md` replaces `x.md` in that harness only.
- An OMP rule with no front matter gets `alwaysApply: true`. A rule with its own front matter, such as `description:`, is copied unchanged.
- `__pycache__` directories are ignored.

## Commands

```sh
harness-kit build [--check] [--root <dir>]
harness-kit stamp <plugin> <semver> [--git-add]
harness-kit validate-claude [--no-strict]
harness-kit check
harness-kit update [--check]
```

| Command | What it does | Exit |
| --- | --- | --- |
| `build` | Writes every generated file and removes stale files in `commonDirs`. | 0, or 2 on an error |
| `build --check` | Lists stale files without writing. | 1 when stale |
| `stamp` | Sets a plugin's version, then regenerates. `--git-add` stages the generated files outside `plugins/`. For a release `prepareCmd`. | 2 on a bad version |
| `validate-claude` | Runs `claude plugin validate` on each Claude tree, then on the marketplace. The `claude` CLI comes from `node_modules/.bin`, then `PATH`; install `@anthropic-ai/claude-code`. | 1 when rejected |
| `check` | `build --check`, then `validate-claude`. Warns when a workflow tag differs from the package pin (below). | 1 on either failure |
| `update` | Reads the pin in `package.json` and `npm view @srobroek/harness-kit version`. If newer, runs `npm install --save-exact`, then the new release's `build`. Prints `old -> new` or `up to date`. Never commits. `--check` only reports. | 1 with `--check` when outdated |

The library exports `readPlugins`, `render`, `drift`, `write`, `stampVersion`, `loadConfig` and `resolveConfig` for tests. Each takes the resolved config as its last argument.

## Presets

- `@srobroek/harness-kit/tsconfig.base.json`: `{ "extends": "@srobroek/harness-kit/tsconfig.base.json", "include": [...] }`.
- `@srobroek/harness-kit/release.config.js`: a semantic-release preset for multi-semantic-release. The forge plugin stays in your repo:

  ```js
  // release.config.mjs
  import { releaseConfig } from "@srobroek/harness-kit/release.config.js"
  export default releaseConfig({ forge: ["@semantic-release/gitlab", { gitlabUrl: "https://gitlab.example.com" }] })
  ```

  Its `prepareCmd` runs `harness-kit stamp "$(basename "$PWD")" ${nextRelease.version} --git-add`. Install `semantic-release`, `@anolilab/multi-semantic-release`, `@semantic-release/changelog`, `@semantic-release/exec`, `@semantic-release/git`, `conventional-changelog-conventionalcommits` and `@visulima/yaml` (which multi-semantic-release imports without declaring) as dev dependencies. Keep `.multi-releaserc` (tag format) in your repo.

## GitHub workflows

```yaml
jobs:
  check:
    uses: srobroek/harness-kit/.github/workflows/check.yml@v1.0.0
  release:
    needs: check
    if: github.ref == 'refs/heads/main'
    uses: srobroek/harness-kit/.github/workflows/release.yml@v1.0.0
    permissions: { contents: write, issues: write, pull-requests: write }
```

- `check.yml`: `npm ci`, `harness-kit check`, `bun test`, `tsc`.
- `release.yml`: `npm ci`, then `multi-semantic-release` with `GITHUB_TOKEN`. Your release config names `@semantic-release/github`.

### The workflow tag must match the package version

The package and the workflows are one release under one `vX.Y.Z` tag. A consumer on package `1.2.3` calls the workflows at `@v1.2.3`. Pin to the tag, never `main`. `harness-kit check` prints a warning for each `.github/workflows/*.yml` line that references harness-kit at another ref. The warning does not fail the check.

## Upgrade path

1. Bump the pin and the workflow tags to the same version.
2. Run `harness-kit build` and commit everything, with the message `chore(deps): bump @srobroek/harness-kit to X.Y.Z`.
3. `harness-kit check` in CI catches a bump whose regenerated files were not committed.

### Renovate

Extend the preset in `renovate.json`:

```json
{ "extends": ["github>srobroek/harness-kit"] }
```

The preset extends `config:recommended`. It puts the npm package and the `srobroek/harness-kit` workflow refs in one `harness-kit` group, so they move in one PR, pinned to the tag. Renovate's hosted app does not run `postUpgradeTasks`, so the PR arrives without the regenerated files. In CI, `harness-kit check` fails on the PR; run `npx harness-kit build` on the PR branch and push the result. Repos without Actions run `harness-kit check` locally before merging.

### Without Renovate: `harness-kit update` in GitLab CI

[`templates/gitlab-deps-bump.yml`](templates/gitlab-deps-bump.yml) holds a `deps-bump` job to copy into `.gitlab-ci.yml`. A scheduled pipeline with `DEPS_BUMP=1` runs `harness-kit update`, skips when the branch `deps/harness-kit-<v>` exists, commits `chore(deps): bump @srobroek/harness-kit to <v>`, pushes with the protected `GITLAB_TOKEN`, and opens a merge request through the API. The MR pipeline runs your normal checks.

#### Schedule pipelines

The workflow rules must let the `schedule` source through, and every other job must refuse it. Otherwise the release job fires on the schedule.

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_PIPELINE_SOURCE == "schedule"          # lets the deps-bump pipeline start
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

check-job:                                           # every existing job
  rules:
    - if: $CI_PIPELINE_SOURCE != "schedule"

release:
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $GITLAB_TOKEN && $CI_PIPELINE_SOURCE != "schedule"
```

## Releasing harness-kit

semantic-release runs from `.github/workflows/publish.yml` on pushes to `main`. It tags `vX.Y.Z`, creates the GitHub release and publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no `NPM_TOKEN`). The job needs npm 11.5.1 or later and `id-token: write`, and it runs only when the repository variable `RELEASE_ENABLED` is `true`. npm accepts a trusted publisher only for a package that exists, so the first version is published by hand, as `AGENTS.md` describes.

## License

Apache-2.0.
