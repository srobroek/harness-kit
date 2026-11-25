import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export const FIXTURE = path.join(import.meta.dir, "fixtures", "repo")
export const CLI = path.join(import.meta.dir, "..", "src", "cli.ts")

const made: string[] = []

export function tempDir(prefix = "harness-kit-test-"): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), prefix))
  made.push(dir)
  return dir
}

export function fixtureCopy(): string {
  const dir = tempDir()
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

export function cleanup(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function script(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

export function runCli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const run = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

type Handler = (event: any, ctx: any) => any

/**
 * A fake pi extension API that records handlers and sent messages, for one session. `emit` runs an event's handlers and
 * returns their results. `sections` runs `before_agent_start` as pi does before a run, from no custom sections, and
 * returns the sections the handlers set.
 */
export function fakePi() {
  const handlers = new Map<string, Handler[]>()
  const sent: Array<{ message: any; options: any }> = []
  const sessionId = crypto.randomUUID()
  const api = {
    on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: unknown, options: unknown) => void sent.push({ message, options }),
  }
  const emit = (event: string, payload: unknown, ctx: unknown = { cwd: "/work", sessionManager: { getSessionId: () => sessionId } }) =>
    (handlers.get(event) ?? []).map((handler) => handler(payload, ctx))
  const sections = (initial: Record<string, string> = {}) => {
    const event = { systemPromptOptions: { sections: { ...initial } } }
    emit("before_agent_start", event)
    return event.systemPromptOptions.sections
  }
  // The runtime modules type their slice of pi's API; the fake records any event, so it stands in for each of them.
  return { api: api as never, handlers, sent, emit, sections }
}
