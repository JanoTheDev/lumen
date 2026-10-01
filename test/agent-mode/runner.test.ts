import { describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '@shared/events'
import type { AgentMessage, ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import {
  capReached,
  DEFAULT_CAPS,
  runAgent,
  type RunnerDeps,
  type RunOptions,
  type ToolHandler
} from '../../src/main/agent-mode/runner'
import { FOREGROUND_TOOLS } from '../../src/main/agent-mode/tools'

const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
let callSeq = 0
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({
  id: `c${++callSeq}`,
  name,
  input
})
const reply = (...calls: ToolCall[]): ToolTurnResult => ({
  message: { role: 'assistant', text: '', calls },
  usage,
  model: 'fake',
  stopReason: calls.length ? 'tool_use' : 'end_turn'
})

interface Harness {
  deps: RunnerDeps
  turns: AgentMessage[][]
  published: AgentTask[]
  spoken: string[]
  acted: Record<string, unknown>[]
}

function harness(
  script: ToolTurnResult[],
  over: Partial<RunnerDeps> = {},
  handlers: Record<string, ToolHandler> = {}
): Harness {
  const h: Harness = { turns: [], published: [], spoken: [], acted: [], deps: {} as RunnerDeps }
  let i = 0
  const act: ToolHandler = async (input) => {
    h.acted.push(input)
    return { content: [{ type: 'text', text: 'ok' }], actions: 1 }
  }
  h.deps = {
    model: {
      plan: async () => ({
        plan: { summary: 'draft an email', steps: ['Open Gmail', 'Write it'], risk: 'low' },
        model: 'fake',
        usage
      }),
      turn: async (req) => {
        h.turns.push(req.messages)
        return script[Math.min(i++, script.length - 1)]
      }
    },
    handlers: {
      act,
      keys: act,
      observe: async () => ({ content: [{ type: 'text', text: 'screen' }] }),
      ...handlers
    },
    publish: (t) => h.published.push(t),
    speak: (t) => h.spoken.push(t),
    countdown: async () => 'elapsed',
    askContinue: async () => false,
    costOf: () => 0.001,
    now: () => Date.now(),
    ...over
  }
  return h
}

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  prompt: 'email Sam',
  context: { window: 'Inbox - Gmail', now: new Date(0) },
  tools: FOREGROUND_TOOLS,
  cancelWindowMs: 3000,
  ...over
})

describe('runAgent', () => {
  it('plans, announces, acts and finishes', async () => {
    const h = harness([
      reply(call('act', { op: 'click', target: { kind: 'element', ref: 'e1' }, step: 1 })),
      reply(call('finish', { summary: 'Draft is ready.', needsUserAction: 'Press Send' }))
    ])
    const r = await runAgent(opts(), h.deps)
    expect(r.status).toBe('done')
    expect(r.needsUserAction).toBe('Press Send')
    expect(h.spoken[0]).toBe("I'll draft an email. Starting in 3.")
    expect(h.spoken.at(-1)).toContain('Draft is ready.')
    expect(h.acted).toHaveLength(1)
    expect(r.task.steps.map((s) => s.status)).toEqual(['done', 'done'])
    expect(r.task.steps[0].detail).toEqual(['click "e1"'])
    expect(r.task.counters).toMatchObject({ actions: 1, modelCalls: 3 })
    expect(h.published.some((t) => t.phase === 'countdown')).toBe(true)
  })

  it('cancel during the countdown makes no actions', async () => {
    const h = harness([reply(call('act', { op: 'click' }))], {
      countdown: async () => 'cancel'
    })
    await expect(runAgent(opts(), h.deps)).rejects.toThrow('Cancelled')
    expect(h.acted).toHaveLength(0)
    expect(h.turns).toHaveLength(0)
    expect(h.spoken.at(-1)).toBe('Stopped.')
    expect(h.published.at(-1)?.phase).toBe('aborted')
  })

  it('an abort during the countdown (Escape) makes no actions', async () => {
    const ac = new AbortController()
    const h = harness([reply(call('act', { op: 'click' }))], {
      countdown: () => {
        setTimeout(() => ac.abort(), 5)
        return new Promise(() => {})
      }
    })
    await expect(runAgent(opts({ signal: ac.signal }), h.deps)).rejects.toThrow()
    expect(h.acted).toHaveLength(0)
  })

  it('cancel mid-loop stops within 100ms of the current await', async () => {
    const ac = new AbortController()
    const slow: ToolHandler = () => new Promise(() => {}) // never settles, ignores the signal
    const h = harness(
      [reply(call('wait_for', { condition: { kind: 'text', value: 'x' }, timeoutMs: 15000 }))],
      {},
      { wait_for: slow }
    )
    const run = runAgent(opts({ signal: ac.signal, skipPlan: true }), h.deps)
    await new Promise((r) => setTimeout(r, 20))
    const t0 = Date.now()
    ac.abort()
    await expect(run).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(100)
    expect(h.published.at(-1)?.phase).toBe('aborted')
  })

  it('a stalled model call is abandoned on abort', async () => {
    const ac = new AbortController()
    const h = harness([], {
      model: { plan: async () => ({ plan: null }), turn: () => new Promise(() => {}) }
    })
    const run = runAgent(opts({ signal: ac.signal, skipPlan: true }), h.deps)
    setTimeout(() => ac.abort(), 10)
    await expect(run).rejects.toThrow()
  })

  it('reaching a cap asks to continue; no stops the task', async () => {
    const askContinue = vi.fn(async () => false)
    const h = harness([reply(call('act', { op: 'click' }))], { askContinue })
    const r = await runAgent(opts({ skipPlan: true, caps: { maxActions: 2 } }), h.deps)
    expect(askContinue).toHaveBeenCalledWith('2 actions', expect.anything())
    expect(r.status).toBe('stopped')
    expect(h.acted).toHaveLength(2)
  })

  it('reaching a cap and saying yes keeps going', async () => {
    let asked = 0
    const h = harness(
      [
        reply(call('act', { op: 'click' })),
        reply(call('act', { op: 'click' })),
        reply(call('finish', { summary: 'Done.' }))
      ],
      { askContinue: async () => (++asked, true) }
    )
    const r = await runAgent(opts({ skipPlan: true, caps: { maxActions: 1 } }), h.deps)
    expect(asked).toBe(1)
    expect(r.status).toBe('done')
  })

  it('feeds tool errors back as is_error', async () => {
    const failing: ToolHandler = async () => {
      throw new Error('target not found')
    }
    const h = harness(
      [reply(call('act', { op: 'click' })), reply(call('finish', { summary: 'Gave up.' }))],
      {},
      { act: failing }
    )
    await runAgent(opts({ skipPlan: true }), h.deps)
    const results = h.turns[1].at(-1)
    expect(results?.role).toBe('user')
    const block = results?.role === 'user' ? results.content[0] : null
    expect(block).toMatchObject({ type: 'tool_result', isError: true })
    expect(JSON.stringify(block)).toContain('target not found')
  })

  it('rejects tools outside the tool set', async () => {
    const h = harness([
      reply(call('act', { op: 'click' })),
      reply(call('finish', { summary: 'x' }))
    ])
    await runAgent(opts({ skipPlan: true, tools: ['observe', 'finish'] }), h.deps)
    expect(h.acted).toHaveLength(0)
    expect(JSON.stringify(h.turns[1].at(-1))).toContain('Unknown tool')
  })

  it('allows one retry per step after a failed check', async () => {
    let n = 0
    const verifying: ToolHandler = async () => {
      n++
      return {
        content: [{ type: 'text', text: 'check failed' }],
        isError: true,
        verifyFailed: true,
        actions: 1
      }
    }
    const h = harness(
      [
        reply(call('act', { op: 'click', step: 1 })),
        reply(call('act', { op: 'click', step: 1 })),
        reply(call('act', { op: 'click', step: 1 })),
        reply(call('finish', { summary: 'Could not.' }))
      ],
      {},
      { act: verifying }
    )
    const r = await runAgent(opts(), h.deps)
    expect(n).toBe(2)
    expect(JSON.stringify(h.turns[2].at(-1))).toContain('do not try this step again')
    expect(JSON.stringify(h.turns[3].at(-1))).toContain('already failed its check twice')
    expect(r.task.steps[0].status).toBe('failed')
  })

  it('pauses when ask_user gets no answer and resumes with the same call', async () => {
    let answered = false
    const ask: ToolHandler = async () =>
      answered
        ? { content: [{ type: 'text', text: 'sam@example.com' }] }
        : { content: [], noAnswer: true }
    const h = harness(
      [reply(call('ask_user', { question: 'Who?' })), reply(call('finish', { summary: 'Done.' }))],
      {},
      { ask_user: ask }
    )
    const first = await runAgent(opts({ skipPlan: true }), h.deps)
    expect(first.status).toBe('paused')
    answered = true
    const second = await runAgent(opts({ resume: first.saved }), h.deps)
    expect(second.status).toBe('done')
    expect(JSON.stringify(h.turns.at(-1))).toContain('sam@example.com')
  })

  it('holds the input lane while it runs', async () => {
    const order: string[] = []
    const h = harness([reply(call('finish', { summary: 'ok' }))], {
      inputLane: {
        acquire: async () => {
          order.push('acquire')
          return () => order.push('release')
        }
      }
    })
    await runAgent(opts({ skipPlan: true }), h.deps)
    expect(order).toEqual(['acquire', 'release'])
  })

  it('does not take the input lane for a non-input tool set', async () => {
    const acquire = vi.fn()
    const h = harness([reply(call('finish', { summary: 'ok' }))], { inputLane: { acquire } })
    await runAgent(opts({ skipPlan: true, tools: ['observe', 'finish'] }), h.deps)
    expect(acquire).not.toHaveBeenCalled()
  })
})

describe('capReached', () => {
  const task = (c: Partial<AgentTask['counters']>): AgentTask =>
    ({ counters: { actions: 0, modelCalls: 0, costUsd: 0, startedAt: 0, ...c } }) as AgentTask
  it('names the first cap reached', () => {
    expect(capReached(task({}), DEFAULT_CAPS, 1000)).toBeNull()
    expect(capReached(task({ modelCalls: 30 }), DEFAULT_CAPS, 0)).toBe('30 model calls')
    expect(capReached(task({ costUsd: 0.5 }), DEFAULT_CAPS, 0)).toBe('$0.50 of model use')
    expect(capReached(task({}), DEFAULT_CAPS, 300_000)).toBe('5 minutes')
  })
})
