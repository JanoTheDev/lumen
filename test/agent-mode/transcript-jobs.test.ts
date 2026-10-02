import { afterEach, describe, expect, it } from 'vitest'
import type { ChatEntry, SubJob } from '@shared/task-chat'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import {
  JOB_STEPS_CHARS,
  MAX_JOB_STEPS,
  TranscriptRecorder
} from '../../src/main/agent-mode/transcript'
import { parseTranscript, TranscriptStore } from '../../src/main/agent-mode/transcript-store'
import { BackgroundManager, type RunOutcome } from '../../src/main/agent-mode/background/manager'
import { runBackground } from '../../src/main/agent-mode/background/run'
import type { BgPorts } from '../../src/main/agent-mode/background/handlers'
import { SubagentPool } from '../../src/main/agent-mode/subagents/pool'
import { tempDir } from '../helpers/fixtures'

// Built at runtime: a key-shaped literal in the repo trips secret scanning.
const KEY = ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUv'].join('-')

const job = (task: string, status: SubJob['status'] = 'running'): SubJob => ({
  role: 'researcher',
  task,
  status,
  costUsd: 0
})

const row = (r: TranscriptRecorder): Extract<ChatEntry, { k: 'tool' }> => {
  const e = r.entries.find((x) => x.k === 'tool')
  if (e?.k !== 'tool') throw new Error('no tool row')
  return e
}

function started(): TranscriptRecorder {
  let t = 0
  const r = new TranscriptRecorder('bg_jobs01', { now: () => ++t })
  r.user('compare prices')
  r.toolStart({ id: 'p1', name: 'run_subagents', input: { jobs: [{}, {}] } })
  r.jobs('p1', [job('shop a'), job('shop b')])
  return r
}

const inner = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({
  id,
  name,
  input
})

describe('sub-agent job steps in the transcript', () => {
  it('keeps each job its own tool rows with labels and short results', () => {
    const r = started()
    const c = inner('j1', 'fetch_url', { url: 'https://a.example/lamp' })
    r.run({ type: 'job', callId: 'p1', job: 0, ev: { type: 'call', call: c } })
    expect(row(r).jobs?.[0].steps).toEqual([
      { n: 1, label: 'Read a.example/lamp', args: 'url: https://a.example/lamp', status: 'running' }
    ])
    r.run({
      type: 'job',
      callId: 'p1',
      job: 0,
      ev: {
        type: 'result',
        call: c,
        outcome: { content: [{ type: 'text', text: '<observed>Price: 10</observed>' }] }
      }
    })
    expect(row(r).jobs?.[0].steps?.[0]).toMatchObject({ status: 'ok', result: 'Price: 10' })
    expect(row(r).jobs?.[1].steps).toBeUndefined()
    // finish and model text are not steps.
    r.run({
      type: 'job',
      callId: 'p1',
      job: 0,
      ev: { type: 'call', call: inner('j2', 'finish', { summary: 'x' }) }
    })
    r.run({ type: 'job', callId: 'p1', job: 0, ev: { type: 'model', text: 'thinking' } })
    expect(row(r).jobs?.[0].steps).toHaveLength(1)
  })

  it('a later jobs update keeps the steps', () => {
    const r = started()
    r.run({
      type: 'job',
      callId: 'p1',
      job: 1,
      ev: { type: 'call', call: inner('j1', 'memory_search', { query: 'lamp' }) }
    })
    r.jobs('p1', [job('shop a', 'done'), { ...job('shop b'), step: 'Searched memory' }])
    expect(row(r).jobs?.[1].steps?.[0].label).toBe('Searched memory for “lamp”')
    expect(row(r).jobs?.[0].status).toBe('done')
  })

  it('redacts secrets in labels, args and results', () => {
    const r = started()
    const c = inner('j1', 'fetch_url', { url: `https://a.example/?key=${KEY}` })
    r.run({ type: 'job', callId: 'p1', job: 0, ev: { type: 'call', call: c } })
    r.run({
      type: 'job',
      callId: 'p1',
      job: 0,
      ev: {
        type: 'result',
        call: c,
        outcome: { content: [{ type: 'text', text: `token ${KEY}` }], isError: true }
      }
    })
    expect(JSON.stringify(r.data())).not.toContain(KEY)
    expect(row(r).jobs?.[0].steps?.[0].status).toBe('error')
  })

  it('keeps the newest steps per job within the count and size caps', () => {
    const r = started()
    for (let i = 0; i < MAX_JOB_STEPS + 15; i++)
      r.run({
        type: 'job',
        callId: 'p1',
        job: 0,
        ev: { type: 'call', call: inner(`j${i}`, 'memory_search', { query: `q${i}` }) }
      })
    const j = row(r).jobs![0]
    expect(j.steps).toHaveLength(MAX_JOB_STEPS)
    expect(j.stepsDropped).toBe(15)
    expect(j.steps?.at(-1)?.label).toContain(`q${MAX_JOB_STEPS + 14}`)

    const big = started()
    for (let i = 0; i < 40; i++) {
      const c = inner(`k${i}`, 'fetch_url', { url: `https://a.example/${'p'.repeat(300)}${i}` })
      big.run({ type: 'job', callId: 'p1', job: 0, ev: { type: 'call', call: c } })
      big.run({
        type: 'job',
        callId: 'p1',
        job: 0,
        ev: {
          type: 'result',
          call: c,
          outcome: { content: [{ type: 'text', text: 'x '.repeat(500) }] }
        }
      })
    }
    const steps = row(big).jobs![0].steps!
    const chars = steps.reduce(
      (n, s) => n + 30 + s.label.length + (s.args ?? '').length + (s.result ?? '').length,
      0
    )
    expect(chars).toBeLessThanOrEqual(JOB_STEPS_CHARS)
    expect(steps.every((s) => (s.result ?? '').length <= 200)).toBe(true)
    expect(row(big).jobs![0].stepsDropped).toBeGreaterThan(0)
  })

  it('marks running steps stopped when the run ends under them', () => {
    const r = started()
    r.run({
      type: 'job',
      callId: 'p1',
      job: 0,
      ev: { type: 'call', call: inner('j1', 'memory_search', {}) }
    })
    r.closeOpen()
    expect(row(r).jobs?.[0]).toMatchObject({
      status: 'stopped',
      steps: [{ status: 'error', result: 'Stopped.' }]
    })
  })

  it('ignores events for unknown calls or jobs', () => {
    const r = started()
    const ev = { type: 'call' as const, call: inner('j1', 'memory_search', {}) }
    r.run({ type: 'job', callId: 'nope', job: 0, ev })
    r.run({ type: 'job', callId: 'p1', job: 5, ev })
    expect(row(r).jobs?.every((j) => !j.steps)).toBe(true)
  })
})

describe('transcript store: job steps', () => {
  let tmp: { dir: string; cleanup: () => void } | undefined
  afterEach(() => tmp?.cleanup())

  it('saves and loads the steps', () => {
    tmp = tempDir()
    const store = new TranscriptStore(tmp.dir)
    const r = started()
    r.run({
      type: 'job',
      callId: 'p1',
      job: 0,
      ev: { type: 'call', call: inner('j1', 'memory_search', { query: 'lamp' }) }
    })
    store.save(r.data())
    const back = store.load('bg_jobs01')!
    const e = back.entries.find((x) => x.k === 'tool')
    expect(e?.k === 'tool' && e.jobs?.[0].steps?.[0].label).toBe('Searched memory for “lamp”')
  })

  it('drops malformed steps and caps a hand-edited list', () => {
    const steps = [
      { n: 1, label: 'ok', status: 'ok' },
      { n: 'x', label: 'bad' },
      null,
      { n: 2, label: 'odd', status: 'weird' },
      ...Array.from({ length: MAX_JOB_STEPS + 3 }, (_, i) => ({
        n: i + 10,
        label: `s${i}`,
        status: 'ok'
      }))
    ]
    const data = parseTranscript(
      {
        id: 'bg_jobs02',
        dropped: 0,
        entries: [
          {
            k: 'tool',
            n: 1,
            at: 1,
            name: 'run_subagents',
            label: 'Asked 2 helpers',
            status: 'ok',
            jobs: [
              { ...job('a', 'done'), steps },
              { ...job('b', 'done'), steps: 'nope' }
            ]
          },
          { k: 'tool', n: 2, at: 2, name: 'x', label: 'y', status: 'ok', jobs: 'bad' }
        ]
      },
      'bg_jobs02'
    )!
    const [first, second] = data.entries
    if (first.k !== 'tool' || second.k !== 'tool') throw new Error('kinds')
    expect(first.jobs?.[0].steps).toHaveLength(MAX_JOB_STEPS)
    expect(first.jobs?.[0].stepsDropped).toBe(4)
    expect(first.jobs?.[1].steps).toBeUndefined()
    expect(second.jobs).toBeUndefined()
  })
})

describe('job steps from a real run_subagents call', () => {
  it('reach the parent transcript under the job row', async () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const reply = (...calls: ToolCall[]): ToolTurnResult => ({
      message: { role: 'assistant', text: '', calls },
      usage,
      model: 'fake',
      stopReason: calls.length ? 'tool_use' : 'end_turn'
    })
    const ports = {
      taskId: 'bg_x',
      child: false,
      fetch: async (url: string) => ({
        url,
        status: 200,
        contentType: 'text/html',
        text: 'Price: 10',
        truncated: false
      }),
      readFile: () => ({ ok: false, error: 'E_DENIED' }),
      memorySearch: () => 'Nothing saved.',
      memoryWrite: () => 'ok',
      notify: () => {},
      ask: async () => 'yes',
      requestForeground: async () => ({ status: 'cancelled' }),
      spawn: async () => ({ id: 'bg_child', ok: true }),
      childCount: () => 0,
      progress: () => {},
      audit: () => {}
    } as unknown as BgPorts
    let t = 0
    const rec = new TranscriptRecorder('bg_sub0', { now: () => ++t })
    let parentTurns = 0
    let n = 0
    const m = new BackgroundManager({
      max: () => 1,
      run: (ctl): Promise<RunOutcome> =>
        runBackground(ctl, {
          caps: { maxModelCalls: 30, maxCostUsd: 0.25, maxWallMs: 900_000 },
          ports,
          turn: async () =>
            ++parentTurns === 1
              ? reply({
                  id: 'p1',
                  name: 'run_subagents',
                  input: { jobs: [{ role: 'researcher', task: 'price at shop a' }] }
                })
              : reply({ id: 'p2', name: 'finish', input: { summary: 'Done.' } }),
          costOf: () => 0,
          now: () => Date.now(),
          subagents: {
            pool: new SubagentPool(() => 2),
            turn: async (req) =>
              req.messages.length === 1
                ? reply({ id: 'j1', name: 'fetch_url', input: { url: 'https://a.example/lamp' } })
                : reply({ id: 'j2', name: 'finish', input: { summary: 'Shop a: 10' } }),
            costOf: () => 0,
            now: () => Date.now(),
            costCapUsd: 0.05
          }
        }),
      emit: () => {},
      record: (_id, e) => {
        if (e.type === 'run') rec.run(e.ev)
      },
      now: () => Date.now(),
      newId: () => `bg_sub${n++}`
    })
    const task = m.start({ prompt: 'compare lamp prices', origin: 'voice' })
    expect((await m.wait(task.id)).phase).toBe('done')
    const jobRow = rec.entries.find((e) => e.k === 'tool' && e.name === 'run_subagents')
    if (jobRow?.k !== 'tool') throw new Error('no row')
    expect(jobRow.jobs?.[0]).toMatchObject({
      status: 'done',
      steps: [{ label: 'Read a.example/lamp', status: 'ok' }]
    })
  })
})
