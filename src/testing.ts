// Test helpers for plugins that vendor the OpenCode runtime. Import from "@srobroek/harness-kit/testing".

export type SystemPart = { type: string; text: string }
export type RegisteredSkill = { id: string; description: string; content: string; [key: string]: unknown }

/**
 * A fake OpenCode host context that records what a plugin registers: the `system` parts pushed through
 * `ctx.session.hook("context")`, the skills added through `ctx.skill.transform`, the agents registered through
 * `ctx.agent.transform` (a draft per id, filled by `editor.update`), and how many registrations were disposed.
 */
export function createFakeContext(config: { options?: unknown; existingSkills?: string[]; existingAgents?: string[] } = {}) {
  const system: SystemPart[] = []
  const skills = new Map<string, RegisteredSkill>(
    (config.existingSkills ?? []).map((id) => [id, { id, description: "own", content: "own" }]),
  )
  const agents = new Map<string, Record<string, unknown>>((config.existingAgents ?? []).map((id) => [id, { system: "own" }]))
  let disposed = 0
  const ctx = {
    options: config.options,
    session: {
      hook: async (_name: string, handler: (event: { system: SystemPart[] }) => void) => {
        handler({ system })
        return { dispose: async () => void disposed++ }
      },
    },
    agent: {
      transform: async (
        change: (editor: { get(id: string): unknown; update(id: string, change: (draft: Record<string, unknown>) => void): void }) => void,
      ) => {
        change({
          get: (id) => agents.get(id),
          update: (id, edit) => {
            const draft = agents.get(id) ?? {}
            edit(draft)
            agents.set(id, draft)
          },
        })
        return { dispose: async () => void disposed++ }
      },
    },
    skill: {
      transform: async (change: (editor: { get(id: string): unknown; add(skill: RegisteredSkill): void }) => void) => {
        change({ get: (id) => skills.get(id), add: (skill) => void skills.set(skill.id, skill) })
        return { dispose: async () => void disposed++ }
      },
    },
  }
  return { ctx, system, skills, agents, disposed: () => disposed }
}
