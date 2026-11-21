# Engineering

This file describes how to build and check this repo. `AGENTS.md` holds the rules for changing it (byte-stable output, no runtime dependencies, release versioning).

## Stack

| Part | Version | Use |
| --- | --- | --- |
| bun | 1.4.4 | Runtime for the TypeScript source (no build step), package manager, test runner. Pinned in `package.json` and in every workflow. |
| TypeScript | 5.9.3 | Type check only (`tsc`, no emit). |
| just | any recent | The task runner. It wraps every script. |
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
| `just verify` | `install`, `test`, `typecheck`, `pack-check` |

`just verify` is the CI gate. `ci.yml` runs the same steps through bun directly, so a green `just verify` predicts a green CI run.

## Approved departures

Bun is the default for installing, running scripts and tests. Two places use npm:

- `publish.yml` runs `npm publish` (through `@semantic-release/npm`) and upgrades npm first. Publishing uses npm trusted publishing (OIDC) with provenance, and `bun publish` is not confirmed to support it.
- `templates/gitlab-deps-bump.yml` installs bun with `npm install --global bun@1.4.4`, because its image is `node:24` and ships no bun.
