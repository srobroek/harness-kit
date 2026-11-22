# Task runner. CI calls these recipes; package.json scripts stay as thin aliases that the recipes run.
set shell := ["sh", "-cu"]

default:
    @just --list

install:
    bun install --frozen-lockfile

test:
    bun run test

typecheck:
    bun run typecheck

# Packs the tarball, installs it with bun and runs the CLI.
pack-check:
    bun run pack-check

# Every check, without the install.
check: test typecheck pack-check

# The CI gate.
verify: install check

# Previews the next version from the commits on the current branch. Does not tag, publish or push.
release-dry-run:
    HARNESS_KIT_NPM_PUBLISH=false bunx semantic-release --dry-run --no-ci --branches "$(git branch --show-current)"

# publish.yml only: tags, writes the changelog and publishes through npm trusted publishing.
release:
    bunx semantic-release
