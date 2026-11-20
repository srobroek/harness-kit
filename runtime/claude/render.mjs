// SessionStart hook: print a template with its options filled in. The output joins the session context.
// Run it as `node "${CLAUDE_PLUGIN_ROOT}/_kit/render.mjs" <template>`, where <template> is a file name under
// `templates/` without the `.md` extension. Claude Code exports each userConfig option as
// CLAUDE_PLUGIN_OPTION_<NAME> (uppercase). A missing or empty value takes the default from options.json.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PLACEHOLDER = /\$\{user_config\.([a-z][a-z0-9_]*)\}/g

export function render(template, defaults, env) {
  return template.replace(PLACEHOLDER, (whole, name) => {
    if (!(name in defaults)) return whole
    const given = env[`CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}`]
    return given === undefined || given === "" ? defaults[name] : given
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2]
  if (!name) {
    console.error("usage: render.mjs <template>")
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const defaults = JSON.parse(readFileSync(join(root, "options.json"), "utf8"))
  const template = readFileSync(join(root, "templates", `${name}.md`), "utf8")
  process.stdout.write(render(template, defaults, process.env))
}
