// Sub-agents in a foreground skill run (08 T49 leftover): run_subagents is offered only when
// the skill confirms nothing (not risky, not an untrusted community skill) and its tool list
// allows it; the jobs work inside the skill's envelope (its guard, its connectors) on the
// skill's model role; spawn_task never; "resume the task" keeps the offer.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { ToolOutcome } from '../../src/main/agent-mode/runner'

const h = vi.hoisted(() => ({
  turns: [] as unknown[],
  script: [] as unknown[],
  jobReqs: [] as { tools: { name: string }[] }[],
  jobScript: [] as unknown[],
  roles: [] as string[],
  guarded: [] as string[],
  mcpCalls: [] as string[],
  skill: null as unknown,
  noAnswer: false
}))

vi.mock('../../src/main/ai/providers', () => ({
  getProvider: () => ({
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
  })
}))
vi.mock('../../src/main/ai/pricing', () => ({ usageCost: () => ({ total: 0 }) }))
vi.mock('../../src/main/ai/skills', () => ({ skillContext: () => '' }))
vi.mock('../../src/main/a11y', () => ({ announce: vi.fn() }))
vi.mock('../../src/main/bus', () => ({ bus: { emit: vi.fn(), on: vi.fn() } }))
vi.mock('../../src/main/config', () => ({
  loadConfig: () => ({
    agent: { cancelWindowMs: 0, background: { readFolders: [] } },
    voice: { language: 'en' }
  })
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/audit/log', () => ({ writeAudit: () => {} }))
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
vi.mock('../../src/main/agent-mode/handlers', () => ({
  createHandlers: () => ({
    observe: async () => ({ content: [{ type: 'text', text: 'screen' }] }),
    ask_user: async () => {
      if (!h.noAnswer) return { content: [{ type: 'text', text: 'The user answered: "yes"' }] }
      h.noAnswer = false
      return { content: [{ type: 'text', text: 'No answer.' }], noAnswer: true }
    }
  })
}))
vi.mock('../../src/main/agent-mode/background', () => ({
  foregroundSpawnHandler: () => vi.fn(),
  backgroundAuditEntry: () => ({}),
  readUnder: () => ({ ok: false, error: 'E_DENIED: no folders are granted.' })
}))
vi.mock('../../src/main/agent-mode/skill-tools', () => ({
  enabledSkill: () => h.skill,
  preloadSkill: () => null,
  skillToolSet: () => ({ defs: [], handlers: {}, index: '' }),
  skillOffersHelpers: (s: { manifest: { permissions: { risky: boolean } }; baseTrust: string }) =>
    !s.manifest.permissions.risky && s.baseTrust !== 'community-untrusted'
}))
vi.mock('../../src/main/agent-mode/skill-run', () => ({
  afterDrift: (p: string) => p,
  finishSkillRun: () => {},
  runStepsForeground: async () => ({ kind: 'none' }),
  // The skill's guard: records every call it sees (the parent's and its helpers').
  skillGuard: () => async (tool: string) => {
    h.guarded.push(tool)
    return null
  }
}))
vi.mock('../../src/main/agent-mode/subagents/host', async () => {
  const { SubagentPool } = await import('../../src/main/agent-mode/subagents/pool')
  const pool = new SubagentPool(() => 4)
  return {
    subagentPool: () => pool,
    subagentSettings: () => ({ max: 4, model: 'main', costCapUsd: 0.1 }),
    subagentTurn: (role: string) => {
      h.roles.push(role)
      return async (req: { tools: { name: string }[] }) => {
        h.jobReqs.push(req)
        const next = h.jobScript.shift()
        if (!next) throw new Error('no more job turns')
        return next
      }
    }
  }
})
vi.mock('../../src/main/skills/creation', () => ({ rememberAgentRun: () => {} }))
vi.mock('../../src/main/ai/memory/search', () => ({
  MEMORY_SEARCH_TOOL: { name: 'memory_search', description: 'm', schema: z.object({}) },
  memorySearchInput: z.object({ query: z.string() })
}))
vi.mock('../../src/main/ai/memory/runtime', () => ({ memorySearchFor: () => '' }))
vi.mock('../../src/main/query/context', () => ({ currentContext: () => null }))
vi.mock('../../src/main/connectors', () => ({
  mcpToolSet: async () => ({
    defs: [
      { name: 'mcp__github__search', description: 'search', schema: z.object({ q: z.string() }) },
      { name: 'mcp__jira__find', description: 'find', schema: z.object({ q: z.string() }) }
    ],
    handlers: {
      mcp__github__search: async (input: { q: string }): Promise<ToolOutcome> => {
        h.mcpCalls.push(input.q)
        return { content: [{ type: 'text', text: '3 issues' }] }
      },
      mcp__jira__find: async (): Promise<ToolOutcome> => ({
        content: [{ type: 'text', text: 'x' }]
      })
    }
  })
}))

import { resumeAgentTask, runAgentTask } from '../../src/main/agent-mode/session'
import type { QueryContext } from '../../src/main/query/context'
import { permissionsSchema } from '../../src/main/skills/manifest'

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
const ctx = { activeWindow: 'Notepad', foreground: { process: 'notepad.exe' } } as QueryContext
const signal = (): AbortSignal => new AbortController().signal
const toolNames = (i: number): string[] =>
  (h.turns[i] as { tools: { name: string }[] }).tools.map((t) => t.name)

function skill(
  o: { risky?: boolean; trust?: string; tools?: string[]; model?: string } = {}
): unknown {
  return {
    manifest: {
      name: 'triage-issues',
      description: 'Triage issues.',
      version: '1.0.0',
      apps: [],
      triggers: [],
      params: {},
      permissions: permissionsSchema.parse({ connectors: ['github'], risky: !!o.risky }),
      context: 'foreground',
      ...(o.tools ? { tools: o.tools } : {}),
      ...(o.model ? { model: o.model } : {})
    },
    dir: '/x',
    origin: 'user',
    baseTrust: o.trust ?? 'mine',
    hasSteps: false,
    warnings: []
  }
}

beforeEach(() => {
  h.turns = []
  h.script = []
  h.jobReqs = []
  h.jobScript = []
  h.roles = []
  h.guarded = []
  h.mcpCalls = []
  h.skill = null
  h.noAnswer = false
})

const run = (): Promise<unknown> =>
  runAgentTask('triage', ctx, signal(), { skill: 'triage-issues', skipPlan: true })

describe('run_subagents in a foreground skill run', () => {
  it('is offered to a trusted skill; jobs work inside its envelope on its model', async () => {
    h.skill = skill({ model: 'planning' })
    h.script = [
      reply(call('run_subagents', { jobs: [{ role: 'general', task: 'find lumen issues' }] })),
      reply(call('finish', { summary: 'Triaged.' }))
    ]
    h.jobScript = [
      reply(call('mcp__github__search', { q: 'lumen' })),
      reply(call('finish', { summary: '3 issues found.' }))
    ]
    await run()
    expect(toolNames(0)).toContain('run_subagents')
    expect(toolNames(0)).not.toContain('spawn_task')
    // The job's tools are the skill's: its own connector only, never the screen.
    const jobTools = h.jobReqs[0].tools.map((t) => t.name)
    expect(jobTools).toContain('mcp__github__search')
    expect(jobTools).not.toContain('mcp__jira__find')
    expect(jobTools).not.toContain('observe')
    // The job's connector call went through the skill's guard.
    expect(h.mcpCalls).toEqual(['lumen'])
    expect(h.guarded.filter((t) => t === 'mcp__github__search')).toHaveLength(1)
    expect(h.roles).toEqual(['planning'])
    expect(JSON.stringify((h.turns[1] as { messages: unknown[] }).messages.at(-1))).toContain(
      'subagent:general'
    )
  })

  it('takes Settings’ helper model when the skill names none', async () => {
    h.skill = skill()
    h.script = [reply(call('finish', { summary: 'ok' }))]
    await run()
    expect(toolNames(0)).toContain('run_subagents')
    expect(h.roles).toEqual(['main'])
  })

  it('is not offered to a risky skill', async () => {
    h.skill = skill({ risky: true })
    h.script = [reply(call('finish', { summary: 'ok' }))]
    await run()
    expect(toolNames(0)).not.toContain('run_subagents')
    expect(toolNames(0)).toContain('mcp__github__search')
  })

  it('is not offered to an untrusted community skill', async () => {
    h.skill = skill({ trust: 'community-untrusted' })
    h.script = [reply(call('finish', { summary: 'ok' }))]
    await run()
    expect(toolNames(0)).not.toContain('run_subagents')
  })

  it('is not offered when the skill’s tool list leaves it out', async () => {
    h.skill = skill({ tools: ['observe', 'finish'] })
    h.script = [reply(call('finish', { summary: 'ok' }))]
    await run()
    expect(toolNames(0)).not.toContain('run_subagents')
  })

  it('"resume the task" keeps the offer and the skill’s helper model', async () => {
    h.skill = skill({ model: 'fast' })
    h.noAnswer = true
    h.script = [reply(call('ask_user', { question: 'Which repo?' }))]
    await run()
    h.turns = []
    h.script = [reply(call('finish', { summary: 'ok' }))]
    await resumeAgentTask(signal())
    expect(toolNames(0)).toContain('run_subagents')
    expect(toolNames(0)).not.toContain('spawn_task')
    expect(new Set(h.roles)).toEqual(new Set(['fast']))
  })
})
