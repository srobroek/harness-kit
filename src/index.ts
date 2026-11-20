// Library entry: the generator functions the CLI wraps, for tests and tooling.
export { CONFIG_FILE, type Config, findRoot, type Harness, KNOWN_HARNESSES, KNOWN_KINDS, type Kind, loadConfig, resolveConfig } from "./config"
export {
  assertSemver,
  bareImports,
  type Drift,
  drift,
  type HarnessInventory,
  type Output,
  type Plugin,
  type PluginOption,
  readPlugin,
  readPlugins,
  render,
  stampVersion,
  write,
} from "./generate"
export { type ValidateOptions, validateClaude } from "./validate-claude"
export { compareVersions, type Exec, PACKAGE_NAME, pinnedVersion, update, type UpdateResult } from "./update"
export { workflowRefWarnings } from "./workflow-refs"
export { RUNTIME_MODULES, RUNTIME_MODULE_NAMES, type RuntimeModuleName, resolveRuntime } from "./runtime"
