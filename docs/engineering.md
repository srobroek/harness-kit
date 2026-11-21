# Engineering

This file describes how to build and check this repo. `AGENTS.md` holds the rules for changing it (byte-stable output, no runtime dependencies, release versioning).

## Stack

| Part | Version | Use |
| --- | --- | --- |
| bun | 1.4.5 | Runtime for the TypeScript source (no build step), package manager, test runner. Pinned in `.mise.toml`, `package.json` and the reusable workflows' `bun-version` input; keep them equal. |
| TypeScript | 5.9.3 | Type check only (`tsc`, no emit). |
| just | 1.58.0 | The task runner. It wraps every script. Pinned in `.mise.toml`. |
| mise | 2026.11.10 | Installs bun and just from `.mise.toml`, locally and in `ci.yml` and `publish.yml` (`jdx/mise-action`, SHA-pinned). Its own version is the action's `version` input. |
| Node | 24 (`engines`: `>=24.10`) | Installed by `actions/setup-node` in the workflows. It runs semantic-release and gives `publish.yml` its npm. |
| semantic-release | 25.0.9 | Tags `vX.Y.Z`, writes the changelog, publishes. |

Dependencies are dev-only and locked in `bun.lock`. The package has no runtime dependencies.

## Layout

See the Layout section of `AGENTS.md`. Source is in `src/`, vendored runtime modules in `runtime/`, tests and fixtures in `tests/`, reusable and own workflows in `.github/workflows/`.

## Commands

| Recipe | Runs |
| --- | --- |
| `just install` | `bun install --frozen-lockfile` |
| `just test` | `bun run test` (`bun test`) |
| `just typecheck` | `bun run typecheck` (`tsc`) |
| `just pack-check` | `bun run pack-check`: packs the tarball, installs it with bun, runs the CLI |
| `just check` | `test`, `typecheck`, `pack-check` |
| `just verify` | `install`, then `check` |
| `just release-dry-run` | `semantic-release --dry-run` on the current branch, with npm publishing off. Needs `GITHUB_TOKEN` |
| `just release` | `semantic-release`; only `publish.yml` runs it |

`just verify` is the CI gate, and `ci.yml` and `publish.yml` call `just` recipes, so a green `just verify` predicts a green CI run. The `package.json` scripts (`test`, `typecheck`, `pack-check`) stay as the commands the recipes run. There is no build step and no linter, so there are no `build` or `lint` recipes.

## Consumers on either lockfile

A consumer migrates from npm to bun on its own schedule, so the tooling reads the lockfile:

- `check.yml` runs `bun install --frozen-lockfile` when `bun.lock` (or `bun.lockb`) exists, and `npm ci` otherwise. `scripts/install-deps.sh` is the tested source of that dispatch; `check.yml` and the GitLab template embed its body, and `tests/install-deps.test.ts` keeps the copies equal. The rest of the job runs under bun either way.
- `harness-kit update` uses bun when a bun lockfile exists, npm when only `package-lock.json` exists, and bun when neither does (`src/package-manager.ts`).
- `templates/gitlab-deps-bump.yml` chooses `bun install --frozen-lockfile` or `npm ci` the same way.
- The Renovate preset's `harness-kit` group covers the `bun` and `npm` managers.

## Approved departures

Bun is the default for installing, running scripts and tests. Two places use npm:

- Publishing stays on npm. `publish.yml` runs `npm publish` (through `@semantic-release/npm`) and upgrades npm first. Publishing uses npm trusted publishing (OIDC) with provenance, and `bun publish` is not confirmed to support it.
- `templates/gitlab-deps-bump.yml` installs bun with `npm install --global bun@1.4.5`, because its image is `node:24` and ships no bun.
