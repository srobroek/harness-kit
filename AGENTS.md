# AGENTS.md

harness-kit is the shared build toolkit for multi-harness agent plugin repos. It is published to npm as `@srobroek/harness-kit`. TypeScript source runs under bun; there is no build step.

Stack, toolchain versions, commands and approved departures: [docs/engineering.md](docs/engineering.md).

## Layout

- `src/config.ts`: harness-kit.json schema, defaults, validation.
- `src/generate.ts`: reads `plugins/<name>/`, renders every generated file, detects drift.
- `src/cli.ts`: the `harness-kit` command. `src/update.ts`, `src/validate-claude.ts`, `src/validate-pi.ts`, `src/workflow-refs.ts` back its commands. `src/package-manager.ts` picks bun or npm for a consumer repo from its lockfile.
- `src/pi.ts`: translates an agent file to pi-subagents front matter. `runtime/pi/rules.ts`: the rules loader that `build` vendors into a pi tree with rules.
- `runtime/pi/prereqs.ts`: the prerequisite check. `build` vendors it into the pi and OMP trees of a plugin with `prerequisites`. `src/config.ts` imports its types and range parser, so the generator accepts what the check reads.
- Shared items: `resolveShared` in `src/generate.ts` resolves a plugin's `shared` list against `<sharedDir>/`; the copies are ordinary common files, so drift and stale removal reuse the `commonDirs` handling.
- `src/runtime.ts`, `runtime/<harness>/`: the modules plugins vendor into `<harness>/_kit/`. `src/testing.ts`: the `@srobroek/harness-kit/testing` helpers.
- `release.config.js`, `tsconfig.base.json`: presets that consumers extend. `default.json`: the Renovate preset.
- `.github/workflows/`: `ci.yml` and `publish.yml` are this repo's own; `check.yml` and `release.yml` are reusable workflows for consumers. `check.yml` installs with bun when the consumer has `bun.lock`, and with `npm ci` when it still has `package-lock.json`.
- `templates/`: files consumers copy.
- `tests/fixtures/repo`: the plugin repo the tests copy and generate.

## Commands

- `bun install --frozen-lockfile`, then `bun test` and `bunx tsc`. `just` wraps every script; `just verify` is the CI gate, and CI calls `just` recipes. `.mise.toml` pins bun and just. `just release-dry-run` previews the next version.
- `bun run pack-check`: packs the tarball, installs it with `bun install` and runs the CLI.

## Rules

- Generated output must stay byte-stable. Any change to `generate.ts` that alters output for an existing config is a breaking change: new behavior goes behind a config key whose default keeps the old bytes, or it ships in a major version. The exception is output that was already invalid, meaning it references a file that does not exist: a fix release may change it.
- Constants that differ between repos belong in harness-kit.json, validated in `config.ts`, with an error naming the field.
- No runtime dependencies. Node and bun built-ins only.
- The package files list is `src`, `runtime`, `tsconfig.base.json`, `release.config.js`.
- A runtime module is vendored output in consumers: keep it dependency-free, free of imports from other harnesses, and compatible with every consumer. A behavior change there reaches consumers only when they bump and rebuild. Tests and fixtures never ship.
- Package version and the reusable workflow tags are the same `vX.Y.Z`. Do not split the package.
- Commits follow Conventional Commits; semantic-release derives the version from them.
- Never create, print or store an npm token. Publishing is OIDC only, from `publish.yml`.

## First publish

Trusted publishing needs an existing package, so v1.0.0 is published by hand once, from a clone at the release commit:

1. `npm login` (session login; no token is stored).
2. `npm publish --access public --provenance=false` (provenance only works from CI).
3. Register the trusted publisher: `npm trust github @srobroek/harness-kit --file publish.yml --repo srobroek/harness-kit --allow-publish` (npm 11.15 or later, 2FA on), or npmjs.com > the package > Settings > Trusted publishing > GitHub Actions, repository `srobroek/harness-kit`, workflow `publish.yml`.
4. `gh variable set RELEASE_ENABLED --body true --repo srobroek/harness-kit`.
5. `npm logout`.

A new trusted publisher expires unless its first CI publish succeeds within 2 days, so merge a releasable commit soon after step 3.
