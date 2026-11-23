#!/bin/sh
# Pack the package, check the tarball contents, then install the tarball with bun install
# and run the CLI from the install against a copy of the test fixture repo.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/harness-kit-pack.XXXXXX")
trap 'rm -rf "$work"' EXIT

cd "$here"
bun pm pack --destination "$work" --quiet >/dev/null
tarball=$(cd "$work" && ls ./*.tgz | sed 's|^\./||')
listing=$(tar -tzf "$work/$tarball")

for want in package/src/cli.ts package/src/index.ts package/tsconfig.base.json package/release.config.js package/runtime/opencode/content.ts package/runtime/claude/render.mjs package/runtime/omp/template-extension.ts package/runtime/pi/rules.ts package/package.json package/README.md; do
  echo "$listing" | grep -qx "$want" || { echo "tarball is missing $want" >&2; exit 1; }
done
if echo "$listing" | grep -E '^package/(tests|scripts|\.github)/|\.test\.ts$|fixtures'; then
  echo "tarball contains tests, fixtures or repo scripts" >&2
  exit 1
fi

dir="$work/consumer"
mkdir -p "$dir"
cp -R "$here/tests/fixtures/repo/." "$dir/"
# The fixture's package.json belongs to the demo plugin under plugins/, not the root; the root has its own.
printf '{"name":"consumer","private":true,"devDependencies":{"@srobroek/harness-kit":"file:%s"}}\n' "$work/$tarball" > "$dir/package.json"
cd "$dir"
bun install >/dev/null
test -x node_modules/.bin/harness-kit || { echo "bun did not link the harness-kit bin" >&2; exit 1; }
node_modules/.bin/harness-kit --version >/dev/null
node_modules/.bin/harness-kit build >/dev/null
node_modules/.bin/harness-kit build --check
echo "bun install: ok"
