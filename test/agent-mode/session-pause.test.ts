// Foreground agent task pause / resume (task chat buttons, "pause the task") and the confirm
// card the task chat may approve (only the task's own one), with the app faked.
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
  noAnswer: false,
  card: null as null | { actionId: string; summary: string },
  onAct: null as null | (() => Promise<void> | void)
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
  confirmPending: () => !!h.card,
  state: () => ({ confirm: h.card ?? undefined }),
  command: () => {}
}))
vi.mock('../../src/main/windows/status', () => ({ setStatus: () => {} }))
vi.mock('../../src/main/agent-mode/handlers', () => ({
  createHandlers: () => ({
    observe: async () => ({ content: [{ type: 'text', text: 'screen' }] }),
    act: async () => {
      h.acts++
      await h.onAct?.()
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

import {
  agentConfirmId,
  agentTaskPaused,
  interceptAgentUtterance,
  pauseAgentTask,
  resumePausedAgentTask,
  runAgentTask,
  runningAgentTaskId,
  stopAgentTask
} from '../../src/main/agent-mode/session'
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
const ctx = { activeWindow: 'Notepad', foreground: { process: 'notepad.exe' } } as QueryContext
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  h.turns = []
  h.script = []
  h.acts = 0
  h.card = null
  h.onAct = null
})

describe('foreground task pause / resume', () => {
  it('holds before the next model turn until resumed', async () => {
    h.script = [
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'OK' } })),
      reply(call('finish', { summary: 'Done.' }))
    ]
    let id = ''
    h.onAct = () => {
      id = runningAgentTaskId() ?? ''
      expect(pauseAgentTask(id)).toBe(true)
    }
    const run = runAgentTask('click ok', ctx, new AbortController().signal, { skipPlan: true })
    await tick(50)
    expect(agentTaskPaused(id)).toBe(true)
    expect(h.turns).toHaveLength(1)
    expect(resumePausedAgentTask(id)).toBe(true)
    await expect(run).resolves.toMatchObject({ text: 'Done.' })
    expect(h.turns).toHaveLength(2)
  })

  it('Stop works while paused; voice "pause the task" and "resume" too', async () => {
    h.script = [
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'OK' } })),
      reply(call('finish', { summary: 'Done.' }))
    ]
    let id = ''
    h.onAct = () => {
      id = runningAgentTaskId() ?? ''
      expect(interceptAgentUtterance('pause the task')).toBe(true)
    }
    const run = runAgentTask('click ok', ctx, new AbortController().signal, { skipPlan: true })
    await tick(50)
    expect(agentTaskPaused(id)).toBe(true)
    expect(interceptAgentUtterance('resume')).toBe(true)
    expect(agentTaskPaused(id)).toBe(false)
    await run
    h.script = [
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'OK' } })),
      reply(call('finish', { summary: 'Done.' }))
    ]
    h.onAct = () => {
      id = runningAgentTaskId() ?? ''
      pauseAgentTask(id)
    }
    const again = runAgentTask('click ok', ctx, new AbortController().signal, { skipPlan: true })
    await tick(50)
    expect(stopAgentTask(id)).toBe(true)
    await expect(again).rejects.toBeTruthy()
    expect(runningAgentTaskId()).toBeNull()
  })
})

describe('the task’s own confirm card', () => {
  it('a card raised during the task’s tool call is the task’s; one from before is not', async () => {
    h.card = { actionId: 'other', summary: 'Claude wants to run rm' }
    h.script = [
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'Send' } })),
      reply(call('finish', { summary: 'Sent.' }))
    ]
    const seen: (string | null)[] = []
    h.onAct = async () => {
      seen.push(agentConfirmId())
      h.card = { actionId: 'mine', summary: 'Click Send' }
      await tick(300)
      seen.push(agentConfirmId())
      h.card = null
    }
    await runAgentTask('send it', ctx, new AbortController().signal, { skipPlan: true })
    expect(seen).toEqual([null, 'mine'])
  })
})
