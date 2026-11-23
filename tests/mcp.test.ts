import { describe, expect, test } from "bun:test"
import { mcpServersForClaude, mcpServersForOmp, piMcpExtension, type McpServers } from "../src/mcp"

const servers: McpServers = {
  enabled: { command: "server" },
  disabled: { command: "server", enabled: false },
  keyless: { command: "context7", optionalHeaders: { "CONTEXT7_API_KEY": "CONTEXT7_API_KEY" } },
  required: { command: "private-server", env: { API_KEY: "${API_KEY}" }, requiredEnv: ["API_KEY"] },
}

describe("MCP output policies", () => {
  test("emits literal required placeholders and keyless servers independent of build credentials", () => {
    const expected = {
      enabled: { command: "server" },
      keyless: { command: "context7" },
      required: { command: "private-server", env: { API_KEY: "${API_KEY}" } },
    }
    expect(mcpServersForClaude(servers)).toEqual(expected)
    expect(mcpServersForOmp(servers)).toEqual(expected)
  })

  test("Pi adds optional headers at runtime and gates explicitly required keys", () => {
    const source = piMcpExtension(servers)
    expect(source).toContain('if (keys.some((key) => !process.env[key])) continue')
    expect(source).toContain('if (value) (config.headers ??= {})[header] = value')
    expect(source).toContain('"CONTEXT7_API_KEY": "CONTEXT7_API_KEY"')
    expect(source).toContain('"required": [\n    "API_KEY"')
    expect(source).not.toContain('"disabled":')
    expect(source).not.toContain('"optionalHeaders":')
  })
})
