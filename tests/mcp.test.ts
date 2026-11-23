import { describe, expect, test } from "bun:test"
import { mcpServersForClaude, mcpServersForOmp, optionalEnvironment, piMcpExtension, type McpServers } from "../src/mcp"

const servers: McpServers = {
  enabled: { command: "server" },
  disabled: { command: "server", enabled: false },
  optional: { command: "server", env: { API_KEY: "${API_KEY}" } },
}

describe("MCP output policies", () => {
  test("finds optional credentials in env and headers", () => {
    expect(optionalEnvironment({ env: { API_KEY: "${API_KEY}" }, headers: { Authorization: "Bearer ${TOKEN}" } })).toEqual(["API_KEY", "TOKEN"])
  })

  test("omits disabled and optional-key servers from harnesses without conditional registration", () => {
    const authoring = { enabled: { command: "server", enabled: true }, disabled: { command: "server", enabled: false } }
    expect(mcpServersForClaude(authoring)).toEqual({ enabled: { command: "server" } })
    expect(mcpServersForOmp(authoring)).toEqual({ enabled: { command: "server" } })
    expect(mcpServersForClaude(servers)).toEqual({ enabled: { command: "server" } })
    expect(mcpServersForOmp(servers)).toEqual({ enabled: { command: "server" } })
  })

  test("registers only enabled Pi servers and guards optional credentials", () => {
    const source = piMcpExtension(servers)
    expect(source).toContain('if (keys.some((key) => !process.env[key])) continue')
    expect(source).toContain('"optional": [\n    "API_KEY"')
    expect(source).toContain('const servers = {\n  "enabled": {\n    "command": "server"\n  },\n  "optional":')
    expect(source).not.toContain('"disabled":')
  })
})
