#!/bin/sh
# Pack the package, check the tarball contents, then install the tarball with npm ci and with bun install
# and run the CLI from each install against a copy of the test fixture repo.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp/opencode}/harness-kit-pack.XXXXXX")
trap 'rm -rf "$work"' EXIT

cd "$here"
tarball=$(npm pack --pack-destination "$work" --silent)
listing=$(tar -tzf "$work/$tarball")

for want in package/src/cli.ts package/src/index.ts package/tsconfig.base.json package/release.config.js package/package.json package/README.md; do
  echo "$listing" | grep -qx "$want" || { echo "tarball is missing $want" >&2; exit 1; }
done
if echo "$listing" | grep -E '^package/(tests|scripts|\.github)/|\.test\.ts$|fixtures'; then
  echo "tarball contains tests, fixtures or repo scripts" >&2
  exit 1
fi

for manager in npm bun; do
  dir="$work/consumer-$manager"
  mkdir -p "$dir"
  cp -R "$here/tests/fixtures/repo/." "$dir/"
  printf '{"name":"consumer","private":true,"devDependencies":{"@srobroek/harness-kit":"file:%s"}}\n' "$work/$tarball" > "$dir/package.json.tmp"
  # The fixture's package.json belongs to the demo plugin under plugins/, not the root; the root has its own.
  mv "$dir/package.json.tmp" "$dir/package.json"
  cd "$dir"
  if [ "$manager" = npm ]; then
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
    npm ci --no-audit --no-fund >/dev/null
  else
    bun install >/dev/null
  fi
  test -x node_modules/.bin/harness-kit || { echo "$manager did not link the harness-kit bin" >&2; exit 1; }
  node_modules/.bin/harness-kit --version >/dev/null
  node_modules/.bin/harness-kit build >/dev/null
  node_modules/.bin/harness-kit build --check
  echo "$manager install: ok"
  cd "$here"
done
