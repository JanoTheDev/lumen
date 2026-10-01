// Foreground agent mode wiring (session.ts) with the app faked: connector (MCP) tools join the
// loop, and skill runs take the steps.json path without any model call, fall back to the
// model after drift, and put the skill's permission guard in front of every tool call.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { ToolOutcome } from '../../src/main/agent-mode/runner'

const h = vi.hoisted(() => ({
  turns: [] as unknown[],
  script: [] as unknown[],
  mcpCalls: [] as unknown[],
  acts: 0,
  skill: null as unknown,
  steps: { kind: 'none' } as unknown,
  guard: null as null | ((tool: string) => Promise<unknown>),
  finished: [] as unknown[],
  remembered: [] as unknown[],
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
vi.mock('../../src/main/agent-mode/handlers', () => ({
  createHandlers: () => ({
    observe: async () => ({ content: [{ type: 'text', text: 'screen' }] }),
    act: async () => {
      h.acts++
      return { content: [{ type: 'text', text: 'clicked' }], actions: 1 }
    },
    ask_user: async () => {
      if (!h.noAnswer) return { content: [{ type: 'text', text: 'The user answered: "yes"' }] }
      h.noAnswer = false
      return { content: [{ type: 'text', text: 'No answer.' }], noAnswer: true }
    }
  })
}))
vi.mock('../../src/main/agent-mode/background', () => ({ foregroundSpawnHandler: () => vi.fn() }))
vi.mock('../../src/main/agent-mode/background/tools', () => ({
  BG_TOOLS: { spawn_task: { name: 'spawn_task', description: 'spawn', schema: z.object({}) } }
}))
vi.mock('../../src/main/agent-mode/skill-tools', () => ({
  enabledSkill: () => h.skill,
  preloadSkill: () => null,
  skillToolSet: () => ({ defs: [], handlers: {}, index: '' })
}))
vi.mock('../../src/main/agent-mode/skill-run', () => ({
  afterDrift: (p: string) => `${p}\n\nDRIFT NOTE`,
  finishSkillRun: (_env: unknown, name: string, run: unknown) => h.finished.push({ name, run }),
  runStepsForeground: async () => h.steps,
  skillGuard: () => (tool: string) => (h.guard ? h.guard(tool) : Promise.resolve(null))
}))
vi.mock('../../src/main/skills/creation', () => ({
  rememberAgentRun: (r: unknown) => h.remembered.push(r)
}))
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
      mcp__github__search: async (input: unknown): Promise<ToolOutcome> => {
        h.mcpCalls.push(input)
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

function skill(connectors: string[] = []): unknown {
  return {
    manifest: {
      name: 'export-png',
      description: 'Export as PNG.',
      version: '1.0.0',
      apps: [],
      triggers: [],
      params: {},
      permissions: permissionsSchema.parse({ input: true, connectors }),
      context: 'foreground',
      tools: ['observe', 'act', 'finish']
    },
    dir: '/x',
    origin: 'user',
    baseTrust: 'mine',
    hasSteps: true,
    warnings: []
  }
}

beforeEach(() => {
  h.turns = []
  h.script = []
  h.mcpCalls = []
  h.acts = 0
  h.skill = null
  h.steps = { kind: 'none' }
  h.guard = null
  h.finished = []
  h.remembered = []
})

describe('agent mode with connectors', () => {
  it('offers the MCP tools and runs their handlers', async () => {
    h.script = [
      reply(call('mcp__github__search', { q: 'lumen' })),
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'OK' } })),
      reply(call('finish', { summary: 'Found 3 issues.' }))
    ]
    const r = await runAgentTask('find lumen issues', ctx, signal(), { skipPlan: true })
    expect(r).toMatchObject({ mode: 'answer', text: 'Found 3 issues.' })
    expect(toolNames(0)).toEqual(
      expect.arrayContaining(['mcp__github__search', 'mcp__jira__find', 'act'])
    )
    expect(h.mcpCalls).toEqual([{ q: 'lumen' }])
    // The finished run is kept for "save that as a skill".
    expect(h.remembered).toMatchObject([{ prompt: 'find lumen issues', steps: [{ tool: 'act' }] }])
  })
})

describe('skill runs', () => {
  it('runs recorded steps with no model call', async () => {
    h.skill = skill()
    h.steps = {
      kind: 'outcome',
      outcome: { status: 'done', ran: 3, actions: 3 },
      labels: [],
      steps: []
    }
    const r = await runAgentTask('export png', ctx, signal(), { skill: 'export-png' })
    expect(r).toMatchObject({ mode: 'answer', text: 'Done: export png, 3 steps.' })
    expect(h.turns).toEqual([])
    expect(h.finished).toEqual([
      {
        name: 'export-png',
        run: { how: 'steps', status: 'done', summary: '3 steps without the model', actions: 3 }
      }
    ])
  })

  it('hands over to the model after drift, with only its own tools and connectors', async () => {
    h.skill = skill(['github'])
    h.steps = {
      kind: 'outcome',
      outcome: { status: 'drift', at: 1, ran: 1, actions: 1, reason: 'gone' },
      labels: [],
      steps: []
    }
    h.script = [reply(call('finish', { summary: 'Exported.' }))]
    await runAgentTask('export png', ctx, signal(), { skill: 'export-png' })
    const first = h.turns[0] as { messages: { content: { text: string }[] }[] }
    expect(first.messages[0].content[0].text).toMatch(/DRIFT NOTE/)
    // No memory_search: the skill does not ask for the profile.
    expect(toolNames(0)).toEqual(['observe', 'act', 'finish', 'mcp__github__search'])
    expect(h.finished).toMatchObject([{ run: { how: 'steps+agent', status: 'done', actions: 1 } }])
  })

  it('puts the permission guard in front of every call', async () => {
    h.skill = { ...(skill() as object), hasSteps: false }
    h.guard = async (tool) =>
      tool === 'act'
        ? { content: [{ type: 'text', text: 'E_DENIED: not allowed' }], isError: true }
        : null
    h.script = [
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'OK' } })),
      reply(call('finish', { summary: 'I could not click.' }))
    ]
    const r = await runAgentTask('export png', ctx, signal(), { skill: 'export-png' })
    expect(h.acts).toBe(0)
    const second = h.turns[1] as { messages: { content: { content?: { text: string }[] }[] }[] }
    expect(second.messages[2].content[0].content?.[0].text).toBe('E_DENIED: not allowed')
    expect(r).toMatchObject({ text: 'I could not click.' })
    expect(h.finished).toMatchObject([{ run: { how: 'agent', status: 'done' } }])
  })

  it('"resume the task" keeps the skill guard, tools and connectors (review M1)', async () => {
    const sk = { ...(skill(['github']) as { manifest: { tools: string[] } }), hasSteps: false }
    sk.manifest = { ...sk.manifest, tools: ['observe', 'act', 'ask_user', 'finish'] }
    h.skill = sk
    h.guard = async (tool) =>
      tool === 'act'
        ? { content: [{ type: 'text', text: 'E_DENIED: not allowed' }], isError: true }
        : null
    h.noAnswer = true
    h.script = [reply(call('ask_user', { question: 'Which file?' }))]
    const first = await runAgentTask('export png', ctx, signal(), { skill: 'export-png' })
    expect(first.text).toMatch(/Paused/)
    h.turns = []
    h.script = [
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'OK' } })),
      reply(call('finish', { summary: 'Stopped.' }))
    ]
    const resumed = resumeAgentTask(signal())
    expect(resumed).not.toBeNull()
    await resumed
    expect(h.acts).toBe(0)
    expect(toolNames(0)).toEqual(['observe', 'act', 'ask_user', 'finish', 'mcp__github__search'])
  })
})
