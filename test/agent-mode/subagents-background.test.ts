import { describe, expect, it } from 'vitest'
import type { BackgroundTask } from '@shared/types'
import type { AgentMessage, ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { BgPorts } from '../../src/main/agent-mode/background/handlers'
import { BackgroundManager, type RunOutcome } from '../../src/main/agent-mode/background/manager'
import { runBackground, type BgRunEnv } from '../../src/main/agent-mode/background/run'
import { SubagentPool } from '../../src/main/agent-mode/subagents/pool'
import { taskRow } from '../../src/renderer/src/panel/home/tasks-view'

const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
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
  stopReason: calls.length ? 'tool_use' : 'end_turn'
})
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

function ports(log: string[]): BgPorts {
  return {
    taskId: 'bg_x',
    child: false,
    fetch: async (url) => {
      log.push(`fetch ${url}`)
      return { url, status: 200, contentType: 'text/html', text: 'Price: 10', truncated: false }
    },
    readFile: () => ({ ok: false, error: 'E_DENIED: no folders are granted.' }),
    memorySearch: () => 'Nothing saved.',
    memoryWrite: () => 'ok',
    notify: () => {},
    ask: async () => 'yes',
    requestForeground: async () => ({ status: 'cancelled' }),
    spawn: async () => ({ id: 'bg_child', ok: true }),
    childCount: () => 0,
    progress: () => {},
    audit: (a, r) => log.push(`audit ${String(a.type)} ${r}`)
  }
}

const isJob = (req: { system: { text: string }[] }): boolean =>
  req.system[0].text.startsWith('You are a Lumen helper')

function setup(opts: {
  parent: (n: number, req: { messages: AgentMessage[] }) => ToolTurnResult
  job: (req: { messages: AgentMessage[] }) => Promise<ToolTurnResult> | ToolTurnResult
  guard?: BgRunEnv['guard']
}): {
  m: BackgroundManager
  log: string[]
  parentReqs: { tools: { name: string }[]; messages: AgentMessage[] }[]
  emitted: BackgroundTask[]
  pool: SubagentPool
} {
  const log: string[] = []
  const parentReqs: { tools: { name: string }[]; messages: AgentMessage[] }[] = []
  const emitted: BackgroundTask[] = []
  const pool = new SubagentPool(() => 4)
  let n = 0
  const m = new BackgroundManager({
    max: () => 3,
    run: (ctl): Promise<RunOutcome> =>
      runBackground(ctl, {
        caps: { maxModelCalls: 30, maxCostUsd: 0.25, maxWallMs: 900_000 },
        ports: ports(log),
        turn: async (req) => {
          parentReqs.push(req)
          return opts.parent(parentReqs.length, req)
        },
        costOf: () => 0.001,
        now: () => Date.now(),
        ...(opts.guard ? { guard: opts.guard } : {}),
        subagents: {
          pool,
          turn: async (req) => {
            if (!isJob(req)) throw new Error('not a job request')
            return opts.job(req)
          },
          costOf: () => 0.01,
          now: () => Date.now(),
          costCapUsd: 0.05
        }
      }),
    emit: (t) => emitted.push(t),
    now: () => Date.now(),
    newId: () => `bg_sub${n++}`
  })
  return { m, log, parentReqs, emitted, pool }
}

describe('run_subagents in a background task', () => {
  it('is offered, jobs use the parent ports, cost counts toward the parent', async () => {
    const { m, log, parentReqs, emitted } = setup({
      parent: (n) =>
        n === 1
          ? reply(
              call('run_subagents', {
                jobs: [
                  { role: 'researcher', task: 'price at shop a' },
                  { role: 'researcher', task: 'price at shop b' }
                ]
              })
            )
          : reply(call('finish', { summary: 'Compared.' })),
      job: (req) => {
        const job = JSON.stringify(req.messages[0])
        const shop = job.includes('shop a') ? 'a' : 'b'
        return req.messages.length === 1
          ? reply(call('fetch_url', { url: `https://${shop}.example/lamp` }))
          : reply(call('finish', { summary: `Shop ${shop}: 10` }))
      }
    })
    const t = m.start({ prompt: 'compare lamp prices', origin: 'voice' })
    const end = await m.wait(t.id)
    expect(end.phase).toBe('done')
    expect(parentReqs[0].tools.map((x) => x.name)).toContain('run_subagents')
    expect(log).toContain('fetch https://a.example/lamp')
    expect(log).toContain('fetch https://b.example/lamp')
    expect(log.filter((l) => l === 'audit fetch_url ok')).toHaveLength(2)
    // 2 parent turns at 0.001 + 4 job turns at 0.01.
    expect(end.counters.costUsd).toBeCloseTo(0.042)
    // The result reached the parent's next turn, fenced.
    expect(JSON.stringify(parentReqs[1].messages.at(-1))).toContain('subagent:researcher')
    // "2 helpers working" while they ran, cleared after.
    expect(emitted.some((x) => x.helpers === 2)).toBe(true)
    expect(end.helpers).toBeUndefined()
  })

  it('the parent guard applies inside the jobs', async () => {
    const { m, log } = setup({
      parent: (n) =>
        n === 1
          ? reply(call('run_subagents', { jobs: [{ role: 'checker', task: 'check x' }] }))
          : reply(call('finish', { summary: 'ok' })),
      job: (req) =>
        req.messages.length === 1
          ? reply(call('fetch_url', { url: 'https://x.example/' }))
          : reply(call('finish', { summary: 'refused' })),
      guard: (tool) => (tool === 'fetch_url' ? 'no web for this automation' : null)
    })
    await m.wait(m.start({ prompt: 'check', origin: 'voice' }).id)
    expect(log).toContain('audit fetch_url denied')
    expect(log.some((l) => l.startsWith('fetch '))).toBe(false)
  })

  it('cancelling the task cancels its jobs', async () => {
    let started = 0
    const { m, pool } = setup({
      parent: () => reply(call('run_subagents', { jobs: [{ role: 'writer', task: 'w' }] })),
      job: () => {
        started++
        return new Promise<ToolTurnResult>(() => {})
      }
    })
    const t = m.start({ prompt: 'write', origin: 'voice' })
    await tick(10)
    expect(started).toBe(1)
    m.cancel(t.id)
    const end = await m.wait(t.id)
    expect(end.phase).toBe('cancelled')
    await tick(5)
    expect(pool.running).toBe(0)
  })

  it('pausing the task holds its jobs between turns', async () => {
    let jobTurns = 0
    let parentId = ''
    const box: { m?: BackgroundManager } = {}
    const s = setup({
      parent: (n) =>
        n === 1
          ? reply(call('run_subagents', { jobs: [{ role: 'researcher', task: 'r' }] }))
          : reply(call('finish', { summary: 'ok' })),
      job: async (req) => {
        jobTurns++
        if (req.messages.length === 1) {
          // Paused while the job's first tool call runs: its next turn waits.
          box.m?.pause(parentId)
          return reply(call('fetch_url', { url: 'https://p.example/' }))
        }
        return reply(call('finish', { summary: 'done' }))
      }
    })
    const m = (box.m = s.m)
    const t = m.start({ prompt: 'research', origin: 'voice' })
    parentId = t.id
    await tick(20)
    expect(jobTurns).toBe(1)
    m.resume(t.id)
    const end = await m.wait(t.id)
    expect(end.phase).toBe('done')
    expect(jobTurns).toBe(2)
  })

  it('a spawned child gets no run_subagents', async () => {
    const { m, parentReqs } = setup({
      parent: () => reply(call('finish', { summary: 'ok' })),
      job: () => reply(call('finish', { summary: 'x' }))
    })
    const child = m.start({
      prompt: 'child',
      origin: 'agent',
      parentId: 'bg_parent',
      immediate: true
    })
    await m.wait(child.id)
    expect(parentReqs[0].tools.map((x) => x.name)).not.toContain('run_subagents')
  })
})

describe('Home Tasks row', () => {
  it('says how many helpers are working', () => {
    const t: BackgroundTask = {
      id: 'bg_a1b2c3',
      title: 'Compare',
      prompt: 'compare',
      origin: 'voice',
      phase: 'running',
      progress: ['Reading a.example'],
      counters: { modelCalls: 1, costUsd: 0, startedAt: 0 },
      helpers: 3
    }
    expect(taskRow(t).status).toBe('3 helpers working')
    expect(taskRow({ ...t, helpers: 1 }).status).toBe('1 helper working')
    expect(taskRow({ ...t, helpers: undefined }).status).toBe('Reading a.example')
  })
})
