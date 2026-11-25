# harness-kit

Shared build tooling for repos that ship agent plugins to OpenCode, Claude Code, OMP and pi. A plugin repo keeps its plugins in `plugins/<name>/`; harness-kit generates the per-harness manifests, marketplaces, copies of shared content and inventories from them, and checks that the generated files are current.

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
| `harnesses` | all four | Harnesses the repo targets. A plugin may list only these. Claude and OMP each get a marketplace file; OpenCode and pi have none. |
| `commonDirs` | `skills`, `rules` | Directories under `plugins/<name>/common/` copied into each harness tree. Add `templates`, `scripts` or `formulas` as needed. |
| `kinds` | the eight kinds without `templates` and `styles` | Rows of the inventory tables and keys of `inventory.json`. Any of `skills agents commands rules templates styles hooks tools extensions mcp`. |
| `sharedDir` | `shared` | Repo-level directory of items that several plugins take; see "Shared items". |
| `pluginKey` | `agent-plugins` | Key in each plugin's `package.json` that holds its settings. |
| `ompScope` | `@agent-plugins` | npm scope of the generated OMP package name. |
| `piScope` | `@agent-plugins` | npm scope of the generated pi package name. |
| `piPrefix` | `""` | Put before the plugin name in the pi package name: `"pi-"` gives `<piScope>/pi-<name>`. Lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. A plugin's `piName` replaces it. |
| `generatedBy` | `harness-kit build` | Names the generator in the note at the top of generated Markdown. |
| `claude.strict` | `true` | `validate-claude` passes `--strict` to `claude plugin validate`. |
| `claude.author`, `claude.license` | none | Written to a Claude manifest whose `package.json` sets no `author` or `license`. `claude.author` also takes a `url`. |
| `claude.homepage`, `claude.repository` | none | `http(s)` URLs written to every Claude manifest and Claude marketplace entry. A plugin's own `claude` settings override them. |
| `omp.packageType` | none | `"module"` or `"commonjs"`: adds `type` to the generated OMP `package.json`. |
| `pi.publish` | `false` | `true` makes each generated pi `package.json` ready for npm. See "Publishing pi packages to npm". |

### MCP servers

Declare shared MCP servers in `plugins/<name>/common/.mcp.json`:

```json
{
  "mcpServers": {
    "docs": { "command": "docs-mcp" },
    "context7": { "command": "context7-mcp", "optionalHeaders": { "x-apikey": "CONTEXT7_API_KEY" } },
    "private": { "command": "private-mcp", "env": { "API_KEY": "${API_KEY}" }, "requiredEnv": ["API_KEY"] },
    "disabled": { "command": "optional-mcp", "enabled": false }
  }
}
```

If the user sets the variable, Pi adds the optional header. OMP omits servers with `requiredEnv` because plugin MCP configs do not expand environment variables. Users can add those servers to `~/.omp/agent/mcp.json`, where OMP expands `${VAR}` at load time. Claude retains required `${VAR}` placeholders in plugin MCP configs. When a variable is unset, Claude warns for stdio servers and leaves the placeholder literal. Remote `url` and `headers` values can resolve to empty strings.

`requiredEnv` lists variables the server needs. OMP omits those servers from generated `mcp.json`. Claude includes the server with its placeholders for load-time expansion. Pi checks these variables at startup. A `${VAR}` placeholder alone does not mean the server needs a credential. Set `enabled` to `false` to disable a server in each generated harness.

`build` writes OMP `mcp.json`, Claude `.mcp.json`, and a Pi `mcp-servers.ts` extension. The MCP inventory lists servers per harness. `build --check` detects changed or stale outputs. Pi extensions register servers with `pi.registerMcpServer`. See [Pi's MCP extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#mcp-servers).

Set credentials in each harness's user scope:

- **OMP:** add an `mcpServers` entry in `~/.omp/agent/mcp.json` for servers that require credentials.
- **Claude:** add the server in Claude's user-scope MCP configuration.
- **Pi:** If you set `requiredEnv`, Pi checks the variable at startup. If you also set the optional header's variable, Pi adds that header.

### Plugin settings

Each plugin's `package.json` carries `name` (equal to the directory), `version`, and the `agent-plugins` key (or your `pluginKey`) with `description`, `category`, `harnesses`, and optionally `scope`, `discrepancies`, `claudeName`, `options` or `userConfig`. Standard `author` and `license` fields go into the Claude manifest.

- `claudeName` renames the plugin in Claude's manifest and marketplace, which sets the `/<name>:<command>` namespace.
- `piName` sets the pi package name without its scope, in place of `piPrefix` and the plugin name: `"piName": "pi-external-repo-worker"` gives `<piScope>/pi-external-repo-worker`. It follows npm's rules for a package name (lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit, 214 characters with the scope). Two plugins with the same pi package name are an error.
- `claude` (optional object) holds Claude-only settings:
  - `dependencies`: a non-empty list copied into the manifest's `dependencies`. Each item is a plugin name, `"name@marketplace"`, or `{ "name", "version", "marketplace" }` where `version` is a semver range such as `~2.1.0`. See [Claude's plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies.md). Declaring a dependency on another marketplace also needs that marketplace in `allowCrossMarketplaceDependenciesOn` in your `marketplace.json`, which this tool does not write.
  - `homepage`, `repository`: `http(s)` URLs that replace the repo-level `claude.homepage` and `claude.repository` for this plugin.
- A `package.json` `author` object may carry a `url`. It is used only when `harness-kit.json` sets `claude.author.url`, so existing repos keep their output. It replaces the whole `claude.author` default; the two are not merged.
- `options` (name to `{ description, default }`) become a Claude `userConfig` and an `options.json` in every harness tree.
- `userConfig` is copied into the Claude manifest as is. Setting both `options` and `userConfig` is an error.
- `prerequisites` lists the external CLIs the plugin needs. See "Prerequisites".
- `companions` lists the pi packages the plugin works with. See "Companions".
- `common/<dir>/x.<harness>.md` replaces `x.md` in that harness only.
- An OMP or pi rule with no front matter gets `alwaysApply: true`. A rule with its own front matter, such as `description:`, is copied unchanged.
- `__pycache__` directories are ignored.

### Shared items

When two plugins ship the same agent, skill or rule, keep one copy in the repo's `shared/` directory (`sharedDir` in the config). Its layout follows `commonDirs`: `shared/agents/x.md`, `shared/skills/y/`, `shared/rules/z.md`. A plugin takes items by listing them in its `agent-plugins` key:

```json
"shared": ["agents/adversarial-challenger", "rules/z"]
```

`harness-kit build` copies each listed item into every harness tree of the plugin, as if it sat in the plugin's own `common/`: the same `x.<harness>.md` variants, the same OMP and pi `alwaysApply` rule, the same pi agent translation. Each plugin stays complete on its own. Copied Markdown carries a `<!-- Generated by … from shared/… -->` header, placed after the front matter so the front matter still parses; other files copy unchanged. `build --check` fails when the shared file changes and a copy does not, and dropping an item removes its copies.

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

### Prerequisites

A plugin declares the external CLIs it needs once, in its `agent-plugins` key, and harness-kit generates the check:

```json
"prerequisites": [
  {
    "bin": "bd",
    "for": "Beads gates and skills",
    "required": true,
    "install": { "mise": "aqua:gastownhall/beads", "url": "https://github.com/steveyegge/beads#install" },
    "version": ">=1.3.0"
  }
]
```

| Field | Default | Meaning |
| --- | --- | --- |
| `bin` | required | The command name, without a path. |
| `for` | required | One line on what the plugin uses the tool for. The notice shows it. |
| `required` | `false` | The plugin's gates need the tool to work. |
| `install.mise` | none | A mise tool; the hint shows `mise use -g <mise>`. |
| `install.url` | none | An http(s) page with install instructions. |
| `install.npm` | none | `<package>@<range>` of an npm package that provides the bin; see "Prerequisites and npm publishing". |
| `version` | none | A semver range, such as `>=1.3.0`, `^2.1` or `>=1.2 <2`, checked against `<bin> --version`. |

`install` needs `mise`, `url` or both. A range uses numbers only. It takes these forms:

- the comparators `<`, `<=`, `>`, `>=` and `=`;
- `^` and `~`;
- partial versions such as `1.2`, and `x` wildcards;
- alternatives joined with `||`.

Hyphen ranges and prerelease tags are errors.

Declaring `prerequisites` vendors the check into the plugin's pi and OMP trees as two files:

- `_kit/prereqs.ts`, listed in the tree's `pi.extensions` or `omp.extensions`;
- `_kit/prereqs.json`, which holds the plugin's name and its list.

Both harnesses get the same module, because they share the `session_start` event and `ctx.ui.notify`. No `runtime` opt-in is needed, and dropping `prerequisites` removes both files. OpenCode and Claude trees get no check; an OpenCode plugin keeps its own. The inventory lists the prerequisites whatever the plugin's harnesses: a "Prerequisites" table in its `INVENTORY.md`, and a `prerequisites` list in `inventory.json`.

At `session_start`, the check does three things:

1. It looks each `bin` up without a shell, as an executable file in a `PATH` directory. Relative entries are skipped.
2. When a `version` is set, it runs `<bin> --version` with a 2-second timeout. It compares the first version-looking token of the output, `1.2` or `1.2.3`, and ignores a suffix such as `-rc.1`.
3. It puts every unmet tool into one notice. A tool is unmet when it is missing, too old, or its version is unreadable. The notice gives each tool's `for` text and install hint: `mise use -g <mise>` when set, then `npm install -g <npm>`, then the URL.

A session with a UI gets the notice as a warning through `ctx.ui.notify`. A session without a UI, as in `pi -p`, writes one line to stderr. That line appears once per process, and never after a UI notice, so OMP subagents stay quiet: they have no UI. When every tool is present, the check reports nothing. The lookups run once per process and the result is cached, so a newly installed tool counts after a restart.

A gate extension calls `missingRequired()` and fails closed when it returns anything. It imports the helpers from its own tree's copy, here from `pi/extensions/gate.ts`:

```ts
import { missingRequired, prereqMessage } from "../_kit/prereqs.ts"

export default function gate(pi) {
  pi.on("tool_call", () => {
    const missing = missingRequired()
    if (missing.length > 0) return { block: true, reason: missing.map((bin) => prereqMessage(bin)).join("\n") }
  })
}
```

`missingRequired()` returns the `bin` of each required tool that is unmet. `prereqMessage(bin)` names the plugin and the tool, says what is wrong, and gives the install hint.

#### Prerequisites and npm publishing

The hint does not assume any one setup. `mise use -g` is one option among the others, and the URL appears whenever the plugin gives one. harness-kit adds no `preinstall`, `install` or `postinstall` script, so installing a plugin runs nothing.

A tool that is itself an npm package, such as repomix, can come with the plugin instead. Set `install.npm` to its package and range, such as `repomix@^1.2.0`. With `pi.publish` on, `build` copies it into `dependencies` of the published pi `package.json`, so installing the package installs the tool (see "Publishing pi packages to npm"). harness-kit adds no `dependencies` to any other manifest; there the plugin author declares the entry.

With `install.npm` set, the check looks in `node_modules/.bin` before `PATH`: first the package's own, then that of each directory above it. A dependency's bin lands in one of those, hoisted or not.

Some tools are not npm packages, so they cannot be dependencies: bd, wt, chezmoi, fnox, uv, gh and python3, for example. For them, the check and its install hint are the only route.

### Companions

An agent package's prompts may refer to skills that other pi packages ship. Someone who installs it alone then gets prompts that point at missing skills. A plugin names those packages in its `agent-plugins` key:

```json
"companions": [
  { "package": "@srobroek/pi-code-quality", "for": "the quality skills the prompts refer to", "required": true },
  { "package": "@srobroek/pi-language-packs", "for": "language skills", "range": "^1.0.0" }
]
```

| Field | Default | Meaning |
| --- | --- | --- |
| `package` | required | The npm name of the pi package, scoped or not. Not one that pi supplies, and not the plugin's own. |
| `for` | required | One line on what the plugin uses it for. |
| `required` | `false` | The plugin's gates need the package to work. |
| `range` | `*` | The semver range of the package in a published `peerDependencies`. |

The pi tree uses the list in three places. OpenCode, Claude and OMP trees do not, because they install no pi packages:

1. `pi/README.md` gets a "Works with" table: each package, whether it is required, what it is for, and `pi install npm:<package>`. It follows the plugin's own `README.md`. A plugin without one gets a heading with the pi package name and its description first. Dropping `companions` leaves the README in place when `pi.publish` is off; delete it by hand.
2. With `pi.publish` on, `pi/package.json` lists each companion in `peerDependencies` at its range, and as optional in `peerDependenciesMeta`.
3. The prerequisite check (`_kit/prereqs.ts`) is vendored for companions too. At `session_start` it reads the `packages` of pi's settings in the agent directory (`$PI_CODING_AGENT_DIR/settings.json`, default `~/.pi/agent/settings.json`) and in the project (`.pi/settings.json`). An entry `npm:<package>`, with or without `@<version>`, counts as installed, and so does a local path whose `package.json` has the companion's name. A git source does not count, because its name is not known without the clone. Each missing companion goes into the same notice as the missing tools, with its install command. `missingRequired()` and `prereqMessage(name)` cover required companions.

### The pi target

[pi](https://pi.dev) installs a plugin as a pi package: `pi install ./plugins/<name>/pi`, or an npm or git source. A plugin that lists `pi` in its `harnesses` gets a `plugins/<name>/pi/` tree, built like the OMP tree:

- `package.json` holds the pi package name, the plugin's version and description, and the `pi-package` keyword. The name is `<piScope>/<piName>`, or `<piScope>/<piPrefix><plugin name>` when the plugin sets no `piName`. Its `pi` key lists only what the tree ships, because an explicit manifest turns off pi's conventional directories:

  | Key | Lists | When |
  | --- | --- | --- |
  | `extensions` | `./extensions/<file>` for each `.ts` or `.js` module, then `./_kit/rules.ts`, then `./_kit/prereqs.ts`; `[]` when the tree ships none of these, no skill and no command | the tree has extension modules, rules or prerequisites, or none of the keys `extensions`, `skills` and `prompts` would appear |
  | `skills` | `./skills` | `skills/` holds a skill |
  | `prompts` | `./commands` | `commands/` holds Markdown: pi loads commands as prompt templates |
  | `subagents.agents` | `./agents` | `agents/` holds an agent, for [pi-subagents](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md) |

  pi loads a package whose manifest lists none of `extensions`, `skills`, `prompts` and `themes` as one extension at the package root, and fails to start. So a package of agents only gets `"extensions": []`.

- The `commonDirs` copies, `x.pi.md` variants and shared items work as for every harness.
- Extensions are hand-authored TypeScript or JavaScript in `pi/extensions/`, as OMP extensions are in `omp/extensions/`. pi loads `.ts` directly, so there is no build step. Each module default-exports a function that takes pi's `ExtensionAPI`.
- Rules: pi has no rules resource, so a tree with rules gets `_kit/rules.ts`, a vendored extension. Before each prompt it sets one system prompt section, which pi renders as `<rules_<package>>…</rules_<package>>`. The section name comes from the `name` in the tree's `package.json`: `@srobroek/pi-workflow-rules` gives `rules_srobroek_pi-workflow-rules`. The section holds every rule whose front matter says `alwaysApply: true`, in full under a `## Rule: <name>` heading. After those comes one index line per other rule. The line gives the rule's `globs` in parentheses, its `description` and the absolute path the model reads it from with `read`. The loader reads the rules once at startup, in file-name order. Before each run pi compares the sections with what the model already has and sends only those that changed. After the first run, an unchanged rules section sends nothing and the cached prompt stays valid. Each package keeps its own section, in the order pi loads the packages, so a session with the same packages gets the same prompt. A rule without front matter gets `alwaysApply: true`, as for OMP. The loader goes away with the last rule.
- Rules with `globs`: `globs` is a glob, a comma-separated string or a list. A glob matches the path as given, absolute, relative to the cwd or by base name. A rule with `globs` and no trigger reaches the model once per session. The loader appends it to the result of the first `read`, `edit` or `write` call whose path matches. A `globs` rule never enters the system prompt: its index line names it and its globs, and its body arrives with the matching file. OMP goes less far: there, `globs` on such a rule only label its index line. A call that a triggered rule blocks gets no result, so the `globs` rule waits for the retry. An `alwaysApply` rule is in the prompt in full and ignores its `globs`.
- Triggered rules: the loader also enforces OMP's trigger front matter. `condition` is a regex or a list of them, and a leading `(?i)`, `(?m)` or `(?s)` becomes a flag. `scope` is a string, a comma-separated string or a list. `interruptMode` decides whether a rule blocks. Each rule fires at most once per session, and keeps its index line:

  | Scope | Tested against | `always`, `tool-only` or no `interruptMode` | `never` or `prose-only` |
  | --- | --- | --- | --- |
  | `tool:bash` | the command, and the call's JSON arguments | blocks the first matching call, with the rule's name and body as the reason; the model can retry it | appends the rule to that call's result |
  | `tool:edit`, `tool:write`, `tool:read`, each with an optional `(<glob>)` | the new text, the content or the path; a glob must match the path as given, absolute, relative to the cwd or by base name | same as above | same as above |
  | `tool` | all four tools | same as above | same as above |
  | `text`, `thinking` | the streamed reply or reasoning | sends the rule as a steering message | the same |

  No `scope` means `text` and every tool. A prose rule steers without aborting: pi delivers a steering message after the current turn's tool calls, and aborting would return it to the editor instead. Tools that pi lacks, such as `tool:eval`, are skipped. As in OMP, `globs` on a triggered rule gate every match on the call's path. Such a rule then fires on `read`, `edit` and `write` calls only, and its `text` and `thinking` scopes are dropped. A rule left with no scope, or with only the never-matching `(?!)`, stays in the index only. A rule with an invalid regex or glob does too, and pi's stderr gets one warning for it. A missing `interruptMode` means `always`, as in OMP, so a rule file behaves the same in both harnesses.

  The loader reads these keys: `alwaysApply`, `description`, `globs`, `condition`, `scope` and `interruptMode`. It ignores the other OMP keys, such as `agents` and `repeatMode`. So a rule restricted by `agents` applies in every session that loads the package. Every triggered rule fires once per session.
- Loading a rules package twice: pi loads an extension path once per session. Two copies of one package both load, for example one installed for the user and one for the project. The first copy to see a session owns it. The other copies add no section, block no call and append nothing in that session.
- Rules in subagents: a foreground [pi-subagents](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md) child runs in the parent's process and never loads the parent's installed packages. It gets the rules only when its launch names the loader, by one of two routes. Each child session then gets its own section and its own once-per-session triggers.
  - Name the loader in the agent's front matter: `subagentOnlyExtensions: <package directory>/_kit/rules.ts`. An agent that lists `extensions` can name it there instead. `subagents.defaultSubagentOnlyExtensions` in pi's settings gives the list to every agent without a list of its own. A package installed from npm lives in `~/.pi/agent/npm/node_modules/<package name>`.
  - Register the package for every child of a session with `registerRequiredChildExtensions` from `pi-subagents/required-child-extensions`. pi-subagents allows one registration per parent session. When another package already owns it, add the rules package's name to that package's list instead: `extraPackages` in a child-gates package.

  A background child loads the installed packages as well, unless its agent lists `extensions`.
- Agents: harness-kit translates each agent to the front matter of pi-subagents. The translation reads the agent's OMP variant (`x.omp.md`) when there is one, because it lists tools, and the plain `x.md` otherwise:
  - It keeps `name` (default: the file name), `description` and the body.
  - It maps `tools` to pi's names: `read` gives `read` and `ls`, `glob` gives `find`, `task` gives `subagent`, and `grep`, `edit`, `write` and `bash` keep theirs. Matching ignores case, so Claude Code's `Read` maps too.
  - It turns OMP `spawns` (other than `*`) into `allowedAgents`.
  - It drops `model`, so the model comes from `subagents.agentOverrides.<name>.model` in pi's settings.
  - It drops tools without a pi counterpart, the OpenCode model tier (the `x-opencode-model-role` request header), `permissions` and every other key. A front-matter comment names each dropped item.

  `build` stops with an error that names the agent file when a translated agent would have no `tools` list. pi-subagents gives such an agent every default tool. An agent restricted only by OpenCode `permissions` would gain tools. Add an `x.pi.md`, or an OMP variant that lists tools. A list whose every tool drops becomes `tools: ""`. pi-subagents reads that as an empty allowlist, so the agent gets no tools. harness-kit copies an `x.pi.md` agent as is. Chains (`x.chain.md`) and other files copy unchanged.
- `validate-pi` checks each tree without running pi. It reports:
  - a `package.json` that is not JSON, or that lacks `name`, `version` or the `pi-package` keyword
  - a path under `pi` that is missing or outside the package
  - a skill without a `SKILL.md`, or a `SKILL.md` without a description
  - an extension that does not parse, or that has no default export
  - an agent whose front matter is not YAML, or that lacks `name` or `description`
  - with `prerequisites` or `companions` declared, a missing `_kit/prereqs.ts`, a `pi.extensions` that does not list it, or a `_kit/prereqs.json` that differs from the lists in the plugin's `package.json`; without them, either file left over

## Commands

```sh
harness-kit build [--check] [--root <dir>]
harness-kit stamp <plugin> <semver> [--git-add]
harness-kit validate-claude [--no-strict]
harness-kit validate-pi
harness-kit check
harness-kit update [--check]
```

| Command | What it does | Exit |
| --- | --- | --- |
| `build` | Writes every generated file and removes stale files in `commonDirs`. | 0, or 2 on an error |
| `build --check` | Lists stale files without writing. | 1 when stale |
| `stamp` | Sets a plugin's version, then regenerates. `--git-add` stages the generated files outside `plugins/`. For a release `prepareCmd`. | 2 on a bad version |
| `validate-claude` | Runs `claude plugin validate` on each Claude tree, then on the marketplace. The `claude` CLI comes from `node_modules/.bin`, then `PATH`; install `@anthropic-ai/claude-code`. | 1 when rejected |
| `validate-pi` | Checks each pi package without running pi. "The pi target" lists the checks. | 1 on a problem |
| `check` | `build --check`, then `validate-claude` and `validate-pi`. Warns when a workflow tag differs from the package pin (below). | 1 on any failure |
| `update` | Reads the pin in `package.json` and the newest version (`bun info @srobroek/harness-kit version`, or `npm view` when the repo has only `package-lock.json`). If newer, runs `bun add --exact` (`npm install --save-exact` for npm; with `--dev` or `--optional` to match the field), then the new release's `build`. Prints `old -> new` or `up to date`. Never commits. `--check` only reports. | 1 with `--check` when outdated |

The library exports `readPlugins`, `render`, `drift`, `write`, `stampVersion`, `loadConfig`, `resolveConfig` and `validatePi` for tests. Each takes the resolved config as its last argument. `piPackageProblems(dir)` returns the `validate-pi` findings for one package directory, and `prerequisiteProblems(dir, plugin)` the prerequisite findings, against a plugin from `readPlugins`.

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

  Pass `publishPi: true` to publish each plugin's pi tree to npm. See "Publishing pi packages to npm".

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
- `release.yml`: `bun install --frozen-lockfile`, then `multi-semantic-release` with `GITHUB_TOKEN`. Your release config names `@semantic-release/github`. The workflow requests no permissions of its own: the token has what the calling job grants.
  - Input `npm-publish` (default `false`): sets up the npm registry and npm 11.5.1 or later, for the preset's `publishPi`. The calling job must also grant `id-token: write`.

### Publishing pi packages to npm

A repo can publish each plugin's pi tree as an npm package, installed with `pi install npm:<package>`, where `<package>` is the pi package name ("The pi target"). It is off by default, so a repo that must not publish needs nothing. To turn it on, set `"pi": { "publish": true }` in `harness-kit.json`.

`build` then adds these fields to every generated pi `package.json`:

| Field | Value |
| --- | --- |
| `license` | The plugin's `package.json` `license`, else the root `package.json` one. One of them is required. |
| `repository` | `{ "type": "git", "url": <root repository>, "directory": "plugins/<name>/pi" }`. The root `package.json` must have `repository`: a GitHub shorthand (`owner/repo`) or an https URL. npm provenance checks it against the repository that publishes. |
| `homepage`, `bugs` | Copied from the root `package.json` when it has them. |
| `files` | Every top-level entry of the tree except `package.json`, `node_modules` and dot-entries: `extensions`, `_kit`, the `commonDirs` copies, `options.json`, `README.md`, `CHANGELOG.md` and `LICENSE`, as present. A file you put in the pi tree ships too. |
| `publishConfig` | `{ "access": "public", "provenance": true }` |
| `dependencies` | The package and range of each prerequisite's `install.npm`, by name: `"repomix@^1.2.0"` gives `"repomix": "^1.2.0"`. Two ranges for one package, or a package that pi supplies, are errors. |
| `peerDependencies` | `"*"` for each host package that the tree's own modules import: `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui` and `typebox`. pi supplies them, so they are never in `dependencies`. Each companion, at its `range`. Sorted by name. |
| `peerDependenciesMeta` | `{ "optional": true }` for each companion. |

The tree also gets copies of the plugin's `README.md` and `CHANGELOG.md` and of the repo's `LICENSE`, when they exist. pi shows a package's `CHANGELOG.md` after an update. `build --check` catches a stale copy. A copy whose source goes away is removed. Turning `pi.publish` off leaves the copies in place; delete them by hand. The generated `package.json` has no `private`, and `dependencies` only from npm prerequisites.

Releases publish through npm trusted publishing (OIDC), with the npm CLI and no `NPM_TOKEN`. bun still installs and runs everything else:

```js
// release.config.mjs
export default releaseConfig({ forge: ["@semantic-release/github"], publishPi: true })
```

```yaml
  release:
    uses: srobroek/harness-kit/.github/workflows/release.yml@vX.Y.Z
    with: { npm-publish: true }
    permissions: { contents: write, issues: write, pull-requests: write, id-token: write }
```

`publishPi` adds `publishCmd` to the preset's `@semantic-release/exec` step: `npm publish ./pi --provenance --access public`, run in each released plugin's directory. A plugin without a pi tree publishes nothing. semantic-release runs the publish step after every prepare step, so after the stamp and the pushed release commit.

npm accepts a trusted publisher only for a package that exists, so publish each package's first version by hand, from a clone at its release commit:

1. `npm login` (a session login; no token is stored).
2. `npm publish ./plugins/<name>/pi --access public --provenance=false`. Provenance works only from CI.
3. `npm trust github <package> --file <workflow>.yml --repo <owner>/<repo> --allow-publish`, with the pi package name from `plugins/<name>/pi/package.json`. This needs npm 11.15 or later and 2FA. Name your repo's workflow file that calls `release.yml`, not `release.yml` itself: npm checks the calling workflow.
4. `npm logout`.

> [!WARNING]
> `publishPi` fails the release for any plugin whose package is not published and trusted yet: without a trusted publisher, npm has no way to authenticate. Publish every package by hand and run `npm trust github` for each one before you turn `npm-publish` on in the caller. A plugin that gets a pi tree later needs the same two steps before its first release.

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

The preset extends `config:recommended` and `security:minimumReleaseAgeNpm` (npm releases wait 3 days). It puts the npm package (read from `bun.lock` through the `bun` manager, or from `package-lock.json` through `npm`), the `srobroek/harness-kit` workflow refs and the versions quoted in Markdown (`@srobroek/harness-kit@X.Y.Z`, `"@srobroek/harness-kit": "X.Y.Z"`, `…/workflows/check.yml@vX.Y.Z`) in one `harness-kit` group, so they move in one PR, pinned to the tag. Write a placeholder such as `X.Y.Z` where the exact version is not the point: the Markdown managers only match a full version. The preset is read from this repository's default branch, so a change to it reaches consumers without an npm release. Renovate's hosted app does not run `postUpgradeTasks`, so the PR arrives without the regenerated files. In CI, `harness-kit check` fails on the PR; run `bunx harness-kit build` on the PR branch and push the result. Repos without Actions run `harness-kit check` locally before merging.

Automerge is Renovate's own (`platformAutomerge: false`), so it needs no branch protection and no GitHub auto-merge setting. Patch updates of packages at 1.0.0 or later, and digest and pin updates, are eligible: Renovate merges such a PR itself, but only when two conditions hold. First, the branch is green with `ignoreTests: false`, which needs at least one check or status that reports success. On GitHub a branch with no checks stays pending and never merges. Second, nobody has pushed to the branch: if a person or another bot adds a commit, such as the regenerated files from `bunx harness-kit build`, Renovate treats the branch as modified and leaves the merge to you. A repo can list the author email of a build bot in [`gitIgnoredAuthors`](https://docs.renovatebot.com/configuration-options/#gitignoredauthors) so that its commits do not count; commits by a person still do. Minor updates stay reviewed PRs, and major updates open their own PR labelled `major`. The `harness-kit` group and `@opencode/*` never automerge. `@opentui/*` and `solid-js` are disabled: OpenCode supplies them at runtime, so pin them by hand to the root catalog of the OpenCode release that `@opencode/*` targets. Security fixes carry a `security` label, skip the schedule and are eligible for automerge under the same two conditions, majors included. Renovate applies `vulnerabilityAlerts` as a forced override that no package rule can veto, so a security fix to the `harness-kit` package or `@opencode/*` also automerges. A security fix does not wait for the 3-day minimum release age either: `vulnerabilityAlerts.minimumReleaseAge` is `null`. The `bun` and `npm` managers follow the same rules. A repo with no CI check never turns green, so give it one before it extends the preset.

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
