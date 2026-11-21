# harness-kit

Shared build tooling for repos that ship agent plugins to OpenCode, Claude Code and OMP. A plugin repo keeps its plugins in `plugins/<name>/`; harness-kit generates the per-harness manifests, marketplaces, copies of shared content and inventories from them, and checks that the generated files are current.

The package is `@srobroek/harness-kit`. It ships TypeScript source that runs under [bun](https://bun.sh), with no build step.

## Install

Pin the exact version, as a dev dependency:

```sh
bun add --dev --exact @srobroek/harness-kit
```

```json
{ "devDependencies": { "@srobroek/harness-kit": "X.Y.Z" } }
```

bun must be on `PATH`, because the `harness-kit` bin has a bun shebang. `bun install` installs it.

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
| `sharedDir` | `shared` | Repo-level directory of items that several plugins take; see "Shared items". |
| `pluginKey` | `agent-plugins` | Key in each plugin's `package.json` that holds its settings. |
| `ompScope` | `@agent-plugins` | npm scope of the generated OMP package name. |
| `generatedBy` | `harness-kit build` | Names the generator in the note at the top of generated Markdown. |
| `claude.strict` | `true` | `validate-claude` passes `--strict` to `claude plugin validate`. |
| `claude.author`, `claude.license` | none | Written to a Claude manifest whose `package.json` sets no `author` or `license`. `claude.author` also takes a `url`. |
| `claude.homepage`, `claude.repository` | none | `http(s)` URLs written to every Claude manifest and Claude marketplace entry. A plugin's own `claude` settings override them. |
| `omp.packageType` | none | `"module"` or `"commonjs"`: adds `type` to the generated OMP `package.json`. |

### Plugin settings

Each plugin's `package.json` carries `name` (equal to the directory), `version`, and the `agent-plugins` key (or your `pluginKey`) with `description`, `category`, `harnesses`, and optionally `scope`, `discrepancies`, `claudeName`, `options` or `userConfig`. Standard `author` and `license` fields go into the Claude manifest.

- `claudeName` renames the plugin in Claude's manifest and marketplace, which sets the `/<name>:<command>` namespace.
- `claude` (optional object) holds Claude-only settings:
  - `dependencies`: a non-empty list copied into the manifest's `dependencies`. Each item is a plugin name, `"name@marketplace"`, or `{ "name", "version", "marketplace" }` where `version` is a semver range such as `~2.1.0`. See [Claude's plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies.md). Declaring a dependency on another marketplace also needs that marketplace in `allowCrossMarketplaceDependenciesOn` in your `marketplace.json`, which this tool does not write.
  - `homepage`, `repository`: `http(s)` URLs that replace the repo-level `claude.homepage` and `claude.repository` for this plugin.
- A `package.json` `author` object may carry a `url`. It is used only when `harness-kit.json` sets `claude.author.url`, so existing repos keep their output. It replaces the whole `claude.author` default; the two are not merged.
- `options` (name to `{ description, default }`) become a Claude `userConfig` and an `options.json` in every harness tree.
- `userConfig` is copied into the Claude manifest as is. Setting both `options` and `userConfig` is an error.
- `common/<dir>/x.<harness>.md` replaces `x.md` in that harness only.
- An OMP rule with no front matter gets `alwaysApply: true`. A rule with its own front matter, such as `description:`, is copied unchanged.
- `__pycache__` directories are ignored.

### Shared items

When two plugins ship the same agent, skill or rule, keep one copy in the repo's `shared/` directory (`sharedDir` in the config). Its layout follows `commonDirs`: `shared/agents/x.md`, `shared/skills/y/`, `shared/rules/z.md`. A plugin takes items by listing them in its `agent-plugins` key:

```json
"shared": ["agents/adversarial-challenger", "rules/z"]
```

`harness-kit build` copies each listed item into every harness tree of the plugin, as if it sat in the plugin's own `common/`: the same `x.<harness>.md` variants, the same OMP `alwaysApply` rule. Each plugin stays complete on its own. Copied Markdown carries a `<!-- Generated by … from shared/… -->` header, placed after the front matter so the front matter still parses; other files copy unchanged. `build --check` fails when the shared file changes and a copy does not, and dropping an item removes its copies.

An item names a file without its extension (`agents/x`) or a directory (`skills/y`). Only listed items are copied. These are errors: an item that does not exist, an item whose first segment is not in `commonDirs` (an `agents` item needs `agents` there), and a plugin that also has its own file at the same path in `common/`.

#### Two installed plugins with the same agent

- **OpenCode:** registering the same agent name twice normally lets the last plugin loaded win. The vendored `agents` module avoids that: `registerAgents(ctx.agent, loadAgentFiles(root))` skips an agent another plugin already registered and logs one debug line (`console.debug`, or the `debug` option). The first plugin loaded wins, so a version skew between the two copies is the same on every start.
- **OpenCode, owner-wins:** when one plugin owns the agent and another ships a fallback copy, the owner's copy should win in either load order. `registerAgents` takes these options:

  | Option | Side | Meaning |
  | --- | --- | --- |
  | `owners` | fallback | Agent id to the owner plugin's name, such as `{ researcher: "agent-researcher" }`. Ids not listed behave as in the default mode. |
  | `plugin` | fallback | The host's `ctx.plugin`. The fallback skips its copy when `plugin.list` reports the owner, or when the id already exists. Without `plugin`, or when `list` fails or takes longer than `listTimeoutMs` (default 2000), the owner counts as not installed. |
  | `pluginMatch` | fallback | How an owner name matches a `plugin.list` entry: `idPrefix` (the entry's `id` equals `idPrefix + name`) and `packagePrefixes` (a package target or local path has `name` or `prefix + name` as a whole segment, ended by the end of the string or one of `@ / # : .`, so `name-extra` does not match). Both default to no prefix. |
  | `role: "owner"` | owner | Replaces an existing copy whose prompt equals its own: permissions and model are dropped, and so is the `fallbackHeader` request header if set. Any other existing agent is layered over: `apply` gets `created = false`, and the default `apply` fills only missing fields. |
  | `fallbackHeader` | owner | Name of the request header that marks a model fallback, such as `x-opencode-model-fallback` in opencode-plugins. Default: none. |

  `apply(draft, file, created)` also shapes agents from outside, for example opencode-plugins' `shapeAgent`. `debug` is a function or a host logger with a `debug` method. The result carries `skipped` and, for an owner, `replaced`.

- **Claude Code:** it prefixes each plugin's agents with the plugin name (`plugin-a:challenger`, `plugin-b:challenger`). Both stay available, and harness-kit cannot change that. A version skew shows up as two agents with different text.

### Vendored runtime modules

Several plugins carry the same runtime code. harness-kit ships it as small modules without dependencies and copies them into a plugin's harness trees. A plugin opts in with `runtime` in its `agent-plugins` key: `true` for every module of its harnesses, or a list.

| Module | Harness | Provides |
| --- | --- | --- |
| `frontmatter` | opencode | `isRecord`, `parseFrontmatter` |
| `content` | opencode | `loadSkills`, `loadRules`, `loadPrompt`, `resolveOptions`, `renderTemplate`, `setupContent`: registers `skills/`, `rules/` and `templates/` with the host. Needs `frontmatter`. |
| `agents` | opencode | `loadAgentFiles`, `registerAgents`, `listsPlugin`, `listPlugins`: registers `agents/*.md`, skipping an agent another plugin already registered, or in owner-wins mode keeping the owner's copy. Needs `frontmatter`. |
| `session` | opencode | `createRootResolver`, `rootOf`: resolve a session to its root session |
| `render` | claude | `render.mjs`, a SessionStart hook: `node "${CLAUDE_PLUGIN_ROOT}/_kit/render.mjs" <template>` prints `templates/<template>.md` with the options filled in |
| `template-extension` | omp | `templateExtension(name)`: an extension that appends the rendered `templates/<name>.md` to the system prompt, with options from `<name>.json` in the OMP agent directory |

`harness-kit build` writes the modules to `<harness>/_kit/` as generated files with a `// Generated by …` header. `build --check` catches edits and leftovers, and dropping `runtime` removes the directory. The installed plugin imports only its own copy: nothing loads harness-kit at runtime, and no harness imports another harness's module. A plugin without `runtime` produces the same output as before. Do not list `_kit` in `commonDirs`.

Test helpers are not vendored. `@srobroek/harness-kit/testing` exports `createFakeContext({ options?, existingSkills?, existingAgents? })`, a fake OpenCode host context that records the system parts, skills, agents and disposals a plugin registers.

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
| `update` | Reads the pin in `package.json` and the newest version (`bun info @srobroek/harness-kit version`, or `npm view` when the repo has only `package-lock.json`). If newer, runs `bun add --exact` (`npm install --save-exact` for npm; with `--dev` or `--optional` to match the field), then the new release's `build`. Prints `old -> new` or `up to date`. Never commits. `--check` only reports. | 1 with `--check` when outdated |

The library exports `readPlugins`, `render`, `drift`, `write`, `stampVersion`, `loadConfig` and `resolveConfig` for tests. Each takes the resolved config as its last argument.

## Presets

- `@srobroek/harness-kit/tsconfig.base.json`: `{ "extends": "@srobroek/harness-kit/tsconfig.base.json", "include": [...] }`.
- `@srobroek/harness-kit/release.config.js`: a semantic-release preset for multi-semantic-release. The forge plugin stays in your repo:

  ```js
  // release.config.mjs
  import { releaseConfig } from "@srobroek/harness-kit/release.config.js"
  export default releaseConfig({ forge: ["@semantic-release/gitlab", { gitlabUrl: "https://gitlab.example.com" }] })
  ```

  Pass `releaseRules` to change which commits cut a release. The list goes to `@semantic-release/commit-analyzer` next to the `conventionalcommits` preset. Without it the output is unchanged. A commit that matches several rules gets the highest release, whatever the order. A commit that matches no rule gets the preset's defaults.

  Once a rule matches a commit, the defaults no longer apply to it. A `refactor!:` commit then cuts only a patch, unless a rule such as `{ breaking: true, release: "major" }` also matches it. Keep that guard in the list.

  ```js
  // release patches for refactor: and docs: commits
  export default releaseConfig({
    releaseRules: [
      { breaking: true, release: "major" }, // without it, "refactor!:" matches only the patch rule
      { type: "refactor", release: "patch" },
      { type: "docs", release: "patch" },
    ],
  })
  ```

  multi-semantic-release merges a package's own semantic-release config over the shared one with `Object.assign`, so a package's `plugins` replaces the whole list. A dry run with `@anolilab/multi-semantic-release` 4.6.3 confirmed that a `release.config.mjs` in a package directory is loaded and its `releaseRules` apply to that package only. To give one package other rules, such as a package below 1.0 that treats a breaking change as a minor release, put a `release.config.mjs` in that package's directory that calls `releaseConfig` again with its own rules and the same `forge`:

  ```js
  // plugins/cad/release.config.mjs
  import { releaseConfig } from "@srobroek/harness-kit/release.config.js"
  export default releaseConfig({
    forge: ["@semantic-release/github"],
    releaseRules: [
      { breaking: true, release: "minor" },
      { type: "refactor", release: "patch" },
      { type: "docs", release: "patch" },
    ],
  })
  ```

  Its `prepareCmd` runs `harness-kit stamp "$(basename "$PWD")" ${nextRelease.version} --git-add`. Install `semantic-release`, `@anolilab/multi-semantic-release`, `@semantic-release/changelog`, `@semantic-release/exec`, `@semantic-release/git`, `conventional-changelog-conventionalcommits` and `@visulima/yaml` (which multi-semantic-release imports without declaring) as dev dependencies. Keep `.multi-releaserc` (tag format) in your repo.

## GitHub workflows

```yaml
jobs:
  check:
    uses: srobroek/harness-kit/.github/workflows/check.yml@vX.Y.Z
  release:
    needs: check
    if: github.ref == 'refs/heads/main'
    uses: srobroek/harness-kit/.github/workflows/release.yml@vX.Y.Z
    permissions: { contents: write, issues: write, pull-requests: write }
```

- `check.yml`: `bun install --frozen-lockfile` when the repo has `bun.lock`, otherwise `npm ci` (so a repo that has not migrated yet keeps working), then `harness-kit check`, `bun test`, `tsc`.
- `release.yml`: `bun install --frozen-lockfile`, then `multi-semantic-release` with `GITHUB_TOKEN`. Your release config names `@semantic-release/github`.

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

The preset extends `config:recommended`. It puts the npm package (read from `bun.lock` through the `bun` manager, or from `package-lock.json` through `npm`), the `srobroek/harness-kit` workflow refs and the versions quoted in Markdown (`@srobroek/harness-kit@X.Y.Z`, `"@srobroek/harness-kit": "X.Y.Z"`, `…/workflows/check.yml@vX.Y.Z`) in one `harness-kit` group, so they move in one PR, pinned to the tag. Write a placeholder such as `X.Y.Z` where the exact version is not the point: the Markdown managers only match a full version. The preset is read from this repository's default branch, so a change to it reaches consumers without an npm release. Renovate's hosted app does not run `postUpgradeTasks`, so the PR arrives without the regenerated files. In CI, `harness-kit check` fails on the PR; run `bunx harness-kit build` on the PR branch and push the result. Repos without Actions run `harness-kit check` locally before merging.

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
