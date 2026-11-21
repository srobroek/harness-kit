#!/bin/sh
# Frozen install for a consumer repo, by lockfile: bun when it has bun.lock or bun.lockb, else npm ci.
# check.yml and templates/gitlab-deps-bump.yml embed the lines below verbatim (tests/install-deps.test.ts keeps them equal),
# because consumers run those files without this repo's scripts.
set -eu
if [ -f bun.lock ] || [ -f bun.lockb ]; then
  bun install --frozen-lockfile
else
  npm ci
fi
