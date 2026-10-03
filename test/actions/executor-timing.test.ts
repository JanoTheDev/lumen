import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }),
    dipToScreenPoint: (p: unknown) => p,
    screenToDipPoint: (p: unknown) => p,
    screenToDipRect: (_w: unknown, r: unknown) => r
  }
}))
vi.mock('../../src/main/ai/observe', () => ({
  waitForSettle: async () => ({ reason: 'timeout', ms: 0 })
}))
const hl = vi.hoisted(() => ({ send: vi.fn(), show: vi.fn(), hide: vi.fn(), clear: vi.fn() }))
vi.mock('../../src/main/windows/highlight', () => hl)
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn() }))
vi.mock('../../src/main/actions/policy', () => ({
  newTaskId: () => 't_test',
  gate: async () => ({ ok: true, decision: { risk: 'low', reason: '' }, finish: () => {} })
}))
const undo = vi.hoisted(() => ({ ms: 0, commits: 0 }))
vi.mock('../../src/main/undo', () => ({
  recordUndo: () =>
    new Promise<() => void>((resolve) =>
      setTimeout(() => resolve(() => void undo.commits++), undo.ms)
    )
}))
type Refine = typeof import('../../src/main/query/refine')
const refine = vi.hoisted(() => ({ available: false, confidence: 0.9 }))
vi.mock('../../src/main/query/refine', () => ({
  needsRefine: (r: { confidence: number; source: string }) =>
    r.confidence < 0.6 || r.source === 'point',
  canRefine: () => refine.available,
  refineTarget: async (...[target]: Parameters<Refine['refineTarget']>) => ({
    target: { ...target, confidence: refine.confidence },
    outcome: 'not-found',
    ms: 0
  })
}))

import type { Action } from '@shared/types'
import { executeActions, type ExecuteOptions } from '../../src/main/actions/executor'
import { setAgent } from '../../src/main/agent/instance'
import type { AgentBridge } from '../../src/main/agent/bridge'

interface Call {
  at: number
  action: Record<string, unknown>
}

function mockAgent(): Call[] {
  const calls: Call[] = []
  const bridge = {
    hasCapability: () => false,
    activeWindow: async () => 'Page - Google Chrome',
    execute: async (action: Record<string, unknown>) => {
      calls.push({ at: Date.now(), action })
      return null
    },
    request: async () => ({})
  }
  setAgent(bridge as unknown as AgentBridge)
  return calls
}

/** Runs a batch on fake timers; ms = fake time from start to the result. */
async function timed(
  actions: Action[],
  opts?: ExecuteOptions
): Promise<{ ms: number; calls: Call[] }> {
  const calls = mockAgent()
  const t0 = Date.now()
  let done = false
  const p = executeActions(actions, opts).finally(() => (done = true))
  while (!done) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
    else await new Promise((r) => setImmediate(r))
  }
  await p
  return { ms: Date.now() - t0, calls: calls.map((c) => ({ ...c, at: c.at - t0 })) }
}

const bboxClick: Action = {
  type: 'click_bbox',
  bbox: { x: 10, y: 20, w: 100, h: 40 },
  description: 'Save'
}

describe('executeActions timing (fake time)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000_000 })
    hl.send.mockClear()
    hl.show.mockClear()
    hl.clear.mockClear()
    undo.ms = 0
    undo.commits = 0
    refine.available = false
    refine.confidence = 0.9
  })
  afterEach(() => {
    vi.useRealTimers()
    setAgent(null)
  })

  it('draws the highlight and pointer before the click and keeps them up 150 ms', async () => {
    const shown: Array<{ channel: string; at: number }> = []
    const t0 = Date.now()
    hl.send.mockImplementation((channel: string) => shown.push({ channel, at: Date.now() - t0 }))
    const { calls } = await timed([bboxClick])
    hl.send.mockReset()
    expect(shown.map((s) => s.channel)).toEqual(['screen:highlights', 'screen:pointer'])
    expect(calls).toHaveLength(1)
    expect(calls[0].at).toBeGreaterThanOrEqual(Math.max(...shown.map((s) => s.at)) + 150)
    expect(hl.clear).toHaveBeenCalled()
  })

  it('gives a low-confidence click its cancel window', async () => {
    refine.available = true
    refine.confidence = 0.35
    const { calls } = await timed([
      {
        type: 'click_target',
        target: { kind: 'point', x: 100, y: 50, frame: '1' },
        description: 'bell'
      }
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].at).toBeGreaterThanOrEqual(2500)
  })

  it('pauses 300 ms after a hotkey', async () => {
    const { ms, calls } = await timed([
      { type: 'hotkey', keys: ['ctrl', 'l'] },
      { type: 'type', text: 'hello' }
    ])
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(300)
    expect(ms).toBeGreaterThanOrEqual(300)
  })

  it('draws nothing with preview off', async () => {
    const { calls } = await timed([bboxClick], { preview: false })
    expect(calls).toHaveLength(1)
    expect(hl.send).not.toHaveBeenCalled()
  })

  it('finishes a confident click batch with preview on in 300 ms', async () => {
    expect((await timed([bboxClick])).ms).toBe(300)
    expect((await timed([{ type: 'click', x: 1, y: 1 }])).ms).toBe(300)
  })

  it('records the undo step while the preview is up', async () => {
    undo.ms = 100
    const { ms, calls } = await timed([bboxClick])
    expect(calls[0].at).toBe(150)
    expect(ms).toBe(300)
    expect(undo.commits).toBe(1)
  })

  it('pauses after each action', async () => {
    const { ms, calls } = await timed([
      { type: 'click', x: 1, y: 1 },
      { type: 'type', text: 'hello' }
    ])
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(150)
    expect(ms).toBe(calls[1].at + 150)
  })

  it('leaves no preview on screen after the batch', async () => {
    await timed([bboxClick, bboxClick])
    expect(hl.clear.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      Math.max(...hl.send.mock.invocationCallOrder)
    )
  })
})
