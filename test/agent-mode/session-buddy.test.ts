// A buddy on screen (08 T52) in session.ts: the foreground task under a buddy's envelope takes
// the buddy's model role and per-run cap, writes memory_write to its notebook, offers helpers
// only when the buddy may, limits use_skill to its skills, gates as origin buddy and reports
// its start and end for the buddy's run history.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { SkillEnvelope } from '../../src/main/agent-mode/skill-envelope'

const h = vi.hoisted(() => ({
  turns: [] as unknown[],
  script: [] as unknown[],
  roles: [] as string[],
  costPerTurn: 0,
  asked: [] as string[],
  env: null as null | { gate?: unknown; prompt: string },
  skillOpts: null as null | { allow?: (s: { manifest: { name: string } }) => boolean }
}))

vi.mock('../../src/main/ai/providers', () => ({
  getProvider: (role: string) => {
    h.roles.push(role)
    return {
      model: 'fake',
      llm: {
        complete: async () => ({ data: null, model: 'fake', usage: {} }),
        toolTurn: async (req: unknown) => {
          h.turns.push(req)
          const next = h.script.shift()
          if (!next) throw new Error('no more turns')
          return next
        }
      }
    }
  }
}))
vi.mock('../../src/main/ai/pricing', () => ({ usageCost: () => ({ total: h.costPerTurn }) }))
vi.mock('../../src/main/ai/skills', () => ({ skillContext: () => '' }))
vi.mock('../../src/main/a11y', () => ({ announce: vi.fn() }))
vi.mock('../../src/main/bus', () => ({ bus: { emit: vi.fn(), on: vi.fn() } }))
vi.mock('../../src/main/config', () => ({
  loadConfig: () => ({ agent: { cancelWindowMs: 0 }, voice: { language: 'en' } })
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/speech/language', () => ({ replyLanguageLine: () => '' }))
vi.mock('../../src/main/speech/wake/arm', () => ({
  withCancelArmed: (fn: () => Promise<unknown>) => fn()
}))
vi.mock('../../src/main/windows/assistant', () => ({
  requestConfirm: async () => true,
  confirmPending: () => false,
  command: () => {}
}))
vi.mock('../../src/main/windows/status', () => ({ setStatus: () => {} }))
vi.mock('../../src/main/agent-mode/confirm', () => ({
  askOwned: async (_task: string, card: { summary: string }) => {
    h.asked.push(card.summary)
    return false
  }
}))
vi.mock('../../src/main/agent-mode/handlers', () => ({
  createHandlers: (env: { gate?: unknown; prompt: string }) => {
    h.env = env
    return { observe: async () => ({ content: [{ type: 'text', text: 'screen' }] }) }
  }
}))
vi.mock('../../src/main/agent-mode/background', () => ({ foregroundSpawnHandler: () => vi.fn() }))
vi.mock('../../src/main/agent-mode/background/tools', () => ({
  BG_TOOLS: {
    spawn_task: { name: 'spawn_task', description: 'spawn', schema: z.object({}) },
    memory_write: {
      name: 'memory_write',
      description: 'note',
      schema: z.object({ fact: z.string() })
    }
  }
}))
vi.mock('../../src/main/agent-mode/skill-tools', () => ({
  enabledSkill: () => null,
  preloadSkill: () => null,
  skillToolSet: (opts: typeof h.skillOpts) => {
    h.skillOpts = opts
    return { defs: [], handlers: {}, index: '' }
  }
}))
vi.mock('../../src/main/agent-mode/subagents/host', () => ({
  subagentPool: () => ({}),
  subagentSettings: () => ({ model: 'main', costCapUsd: 0.1 }),
  subagentTurn: (role: string) => {
    h.roles.push(`sub:${role}`)
    return vi.fn()
  }
}))
vi.mock('../../src/main/agent-mode/skill-run', () => ({
  afterDrift: (p: string) => p,
  finishSkillRun: () => {},
  runStepsForeground: async () => ({ kind: 'none' }),
  skillGuard: () => async () => null
}))
vi.mock('../../src/main/skills/creation', () => ({ rememberAgentRun: () => {} }))
vi.mock('../../src/main/ai/memory/search', () => ({
  MEMORY_SEARCH_TOOL: { name: 'memory_search', description: 'm', schema: z.object({}) },
  memorySearchInput: z.object({ query: z.string() })
}))
vi.mock('../../src/main/ai/memory/runtime', () => ({ memorySearchFor: () => '' }))
vi.mock('../../src/main/query/context', () => ({ currentContext: () => null }))
vi.mock('../../src/main/connectors', () => ({
  mcpToolSet: async () => ({ defs: [], handlers: {} })
}))

import { runAgentTask, type UnderEnvelope } from '../../src/main/agent-mode/session'
import type { RunResult } from '../../src/main/agent-mode/runner'
import type { QueryContext } from '../../src/main/query/context'

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
let seq = 0
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({
  id: `c${++seq}`,
  name,
  input
})
const reply = (...calls: ToolCall[]): ToolTurnResult => ({
  message: { role: 'assistant', text: '', calls },
  usage,
  model: 'fake',
  stopReason: 'tool_use'
})
const ctx = { activeWindow: 'Mail', foreground: { process: 'outlook.exe' } } as QueryContext
const toolNames = (i: number): string[] =>
  (h.turns[i] as { tools: { name: string }[] }).tools.map((t) => t.name)
const toolResults = (i: number): string =>
  JSON.stringify((h.turns[i] as { messages: unknown[] }).messages.at(-1))

const envelope: SkillEnvelope = {
  skill: 'Mail Buddy (buddy)',
  guard: async () => null,
  tools: ['finish', 'ask_user', 'observe'],
  connectors: [],
  network: [],
  readRoots: [],
  offers: () => true
}

function under(p: Partial<UnderEnvelope> = {}): UnderEnvelope {
  return {
    make: () => envelope,
    scope: { origin: 'buddy', buddyId: 'mail-buddy' },
    gate: { origin: 'buddy', buddyId: 'mail-buddy' },
    role: 'fast',
    caps: { maxCostUsd: 0.3 },
    subagents: false,
    allowSkill: (name) => name === 'tidy-inbox',
    memoryWrite: () => 'ok',
    ...p
  }
}

beforeEach(() => {
  h.turns = []
  h.script = []
  h.roles = []
  h.costPerTurn = 0
  h.asked = []
  h.env = null
  h.skillOpts = null
})

describe('a buddy on screen', () => {
  it('plans and works on the buddy model and stops at its per-run budget', async () => {
    h.costPerTurn = 0.2
    h.script = [
      reply(call('observe')),
      reply(call('observe')),
      reply(call('finish', { summary: 'x' }))
    ]
    await runAgentTask('sort mail', ctx, new AbortController().signal, {
      underEnvelope: under()
    })
    expect(h.roles.length).toBeGreaterThan(0)
    expect(new Set(h.roles)).toEqual(new Set(['fast']))
    // At $0.20 a call (the plan counts too) the buddy's $0.30 is reached long before $0.50.
    expect(h.turns.length).toBeLessThan(3)
    expect(h.asked).toEqual([expect.stringContaining('$0.30')])
  })

  it('writes notes to its notebook, offers helpers only when it may, and only its skills', async () => {
    const notes: string[] = []
    h.script = [
      reply(call('memory_write', { fact: 'Boss is Ann.' })),
      reply(call('finish', { summary: 'Noted.' }))
    ]
    await runAgentTask('sort mail', ctx, new AbortController().signal, {
      skipPlan: true,
      underEnvelope: under({ memoryWrite: (f) => (notes.push(f), 'ok') })
    })
    expect(notes).toEqual(['Boss is Ann.'])
    expect(toolResults(1)).toContain('Kept in your notebook.')
    expect(toolNames(0)).toContain('memory_write')
    expect(toolNames(0)).not.toContain('run_subagents')
    expect(toolNames(0)).not.toContain('spawn_task')
    const allow = h.skillOpts?.allow
    expect(allow?.({ manifest: { name: 'tidy-inbox' } })).toBe(true)
    expect(allow?.({ manifest: { name: 'send-invoices' } })).toBe(false)

    h.turns = []
    h.script = [reply(call('finish', { summary: 'Done.' }))]
    await runAgentTask('sort mail', ctx, new AbortController().signal, {
      skipPlan: true,
      underEnvelope: under({ subagents: true })
    })
    expect(toolNames(0)).toContain('run_subagents')
    expect(toolNames(0)).not.toContain('spawn_task')
    expect(h.roles).toContain('sub:fast')
  })

  it('gates as the buddy and reports its start and end', async () => {
    const started: string[] = []
    const ended: RunResult[] = []
    h.script = [reply(call('finish', { summary: 'Sorted.' }))]
    await runAgentTask('sort mail', ctx, new AbortController().signal, {
      skipPlan: true,
      userText: 'Sort my mail.',
      underEnvelope: under({ onStart: (id) => started.push(id), onEnd: (r) => ended.push(r) })
    })
    expect(h.env?.gate).toEqual({ origin: 'buddy', buddyId: 'mail-buddy' })
    expect(h.env?.prompt).toBe('Sort my mail.')
    expect(started).toHaveLength(1)
    expect(ended).toMatchObject([{ status: 'done', summary: 'Sorted.', task: { id: started[0] } }])
  })

  it('a plain agent task gates as the agent', async () => {
    h.script = [reply(call('finish', { summary: 'Ok.' }))]
    await runAgentTask('do it', ctx, new AbortController().signal, { skipPlan: true })
    expect(h.env?.gate).toBeUndefined()
    expect(h.roles).toContain('main')
    expect(h.roles).not.toContain('fast')
    expect(toolNames(0)).not.toContain('memory_write')
  })
})
