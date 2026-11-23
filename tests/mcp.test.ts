import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { mcpServersForClaude, mcpServersForOmp, piMcpExtension, type McpServers } from "../src/mcp"

const servers: McpServers = {
  enabled: { command: "server" },
  disabled: { command: "server", enabled: false },
  keyless: { command: "context7", optionalHeaders: { "CONTEXT7_API_KEY": "CONTEXT7_API_KEY" } },
  required: { command: "private-server", env: { API_KEY: "${API_KEY}" }, requiredEnv: ["API_KEY"] },
}

const transportServers: McpServers = {
  commandDefault: { command: "stdio-server" },
  streamable: { type: "http", url: "https://example.com/mcp" },
  sse: { type: "sse", url: "https://example.com/events" },
}
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("MCP output policies", () => {
  test("normalizes OMP transports and fails invalid declarations", () => {
    expect(mcpServersForClaude(servers)).toEqual({
      enabled: { command: "server" },
      keyless: { command: "context7" },
      required: { command: "private-server", env: { API_KEY: "${API_KEY}" } },
    })
    expect(mcpServersForOmp(servers, "fixture")).toEqual({ enabled: { command: "server", type: "stdio" }, keyless: { command: "context7", type: "stdio" } })
    expect(mcpServersForOmp(transportServers, "fixture")).toEqual({
      commandDefault: { command: "stdio-server", type: "stdio" },
      streamable: { type: "streamable-http", url: "https://example.com/mcp" },
      sse: { type: "sse", url: "https://example.com/events" },
    })
    expect(() => mcpServersForOmp({ invalid: {} }, "demo")).toThrow('plugin "demo" MCP server "invalid" needs a command or url')
  })
  test("executes the generated Pi extension with missing and present credentials", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-kit-pi-mcp-"))
    scratch.push(dir)
    const source = path.join(dir, "extension.ts")
    const module = path.join(dir, "extension.mjs")
    writeFileSync(source, piMcpExtension(servers))
    const compile = Bun.spawnSync([process.execPath, "build", source, "--outfile", module])
    expect(compile.exitCode).toBe(0)
    const typecheck = Bun.spawnSync([process.execPath, "x", "tsc", "--noEmit", "--strict", "--target", "ES2023", "--module", "ESNext", "--moduleResolution", "bundler", source])
    expect(typecheck.exitCode).toBe(0)
    const { default: register } = await import(`${pathToFileURL(module).href}?${Date.now()}`)
    const previousKey = process.env.API_KEY
    const previousContext7 = process.env.CONTEXT7_API_KEY
    try {
      delete process.env.API_KEY
      delete process.env.CONTEXT7_API_KEY
      const withoutCredentials: Array<[string, Record<string, unknown>]> = []
      register({ registerMcpServer: (name: string, config: Record<string, unknown>) => withoutCredentials.push([name, config]) })
      expect(withoutCredentials.map(([name]) => name)).toEqual(["enabled", "keyless"])
      expect(withoutCredentials.find(([name]) => name === "keyless")?.[1]).toEqual({ command: "context7" })

      process.env.API_KEY = "private-secret"
      process.env.CONTEXT7_API_KEY = "context7-secret"
      const withCredentials: Array<[string, Record<string, unknown>]> = []
      register({ registerMcpServer: (name: string, config: Record<string, unknown>) => withCredentials.push([name, config]) })
      expect(withCredentials.map(([name]) => name)).toEqual(["enabled", "keyless", "required"])
      expect(withCredentials.find(([name]) => name === "keyless")?.[1]).toEqual({ command: "context7", headers: { CONTEXT7_API_KEY: "context7-secret" } })
      expect(withCredentials.find(([name]) => name === "required")?.[1]).toEqual({ command: "private-server", env: { API_KEY: "private-secret" } })

      delete process.env.CONTEXT7_API_KEY
      const afterUnset: Array<[string, Record<string, unknown>]> = []
      register({ registerMcpServer: (name: string, config: Record<string, unknown>) => afterUnset.push([name, config]) })
      expect(afterUnset.find(([name]) => name === "keyless")?.[1]).toEqual({ command: "context7" })
    } finally {
      if (previousKey === undefined) delete process.env.API_KEY
      else process.env.API_KEY = previousKey
      if (previousContext7 === undefined) delete process.env.CONTEXT7_API_KEY
      else process.env.CONTEXT7_API_KEY = previousContext7
    }
  })
})
