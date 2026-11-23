import { describe, expect, test } from "bun:test"
import { mcpServersForClaude, mcpServersForOmp, mcpServersForPi, piMcpExtension, type McpServers } from "../src/mcp"

const servers: McpServers = {
  enabled: { command: "server" },
  disabled: { command: "server", enabled: false },
  keyless: { command: "context7", optionalHeaders: { "CONTEXT7_API_KEY": "CONTEXT7_API_KEY" } },
  required: { command: "private-server", env: { API_KEY: "${API_KEY}" }, requiredEnv: ["API_KEY"] },
}

describe("MCP output policies", () => {
  test("preserves keyless servers without optional headers and omits missing required credentials", () => {
    const safe = { enabled: { command: "server" }, keyless: { command: "context7" } }
    expect(mcpServersForClaude(servers, {})).toEqual(safe)
    expect(mcpServersForOmp(servers, {})).toEqual(safe)
    expect(mcpServersForClaude(servers, { API_KEY: "present" })).toHaveProperty("required")
    expect(mcpServersForOmp(servers, { API_KEY: "present" })).toHaveProperty("required")
    expect(mcpServersForPi(servers, {}).keyless).toEqual({ command: "context7" })
    expect(mcpServersForPi(servers, { CONTEXT7_API_KEY: "present" }).keyless).toEqual({ command: "context7", headers: { CONTEXT7_API_KEY: "present" } })
    expect(mcpServersForPi(servers, {}).required).toBeUndefined()
  })

  test("adds optional Pi headers only when present and gates required credentials", () => {
    const source = piMcpExtension(servers)
    expect(source).toContain('if (keys.some((key) => !process.env[key])) continue')
    expect(source).toContain('if (value) (config.headers ??= {})[header] = value')
    expect(source).toContain('"CONTEXT7_API_KEY": "CONTEXT7_API_KEY"')
    expect(source).toContain('"required": [\n    "API_KEY"')
    expect(source).not.toContain('"disabled":')
    expect(source).not.toContain('"optionalHeaders":')
  })
})
