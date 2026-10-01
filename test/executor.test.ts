import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const openExternal = vi.fn(async () => {})
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternal(url) },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }),
    dipToScreenPoint: (p: unknown) => p,
    screenToDipPoint: (p: unknown) => p,
    screenToDipRect: (_w: unknown, r: unknown) => r
  }
}))
vi.mock('../src/main/util', () => ({ sleep: async () => {} }))
vi.mock('../src/main/ai/observe', () => ({
  waitForSettle: async () => ({ reason: 'timeout', ms: 0 })
}))
vi.mock('../src/main/windows/highlight', () => ({ send: vi.fn(), show: vi.fn(), hide: vi.fn() }))
vi.mock('../src/main/windows/status', () => ({ setStatus: vi.fn() }))
type Refine = typeof import('../src/main/query/refine')
const refineTarget = vi.fn<Refine['refineTarget']>(async (target) => ({
  target,
  outcome: 'skipped',
  ms: 0
}))
let refineAvailable = false
vi.mock('../src/main/query/refine', () => ({
  needsRefine: (r: { confidence: number; source: string }) =>
    r.confidence < 0.6 || r.source === 'point',
  canRefine: () => refineAvailable,
  refineTarget: (...args: Parameters<Refine['refineTarget']>) => refineTarget(...args)
}))
vi.mock('../src/main/ai/app-context', () => ({ isBrowser: () => true }))

import type { Action } from '@shared/types'
import { executeActions } from '../src/main/actions/executor'
import { frameGeometryOf } from '../src/main/actions/coords'
import { setCurrentContext, type QueryContext } from '../src/main/query/context'
import { setAgent } from '../src/main/agent/instance'
import type { AgentBridge } from '../src/main/agent/bridge'
import { DwellController, setDwellController, type DwellIo } from '../src/main/a11y/dwell'

interface MockAgent {
  caps: string[]
  window: string
  calls: Array<{ cmd: string; action?: Record<string, unknown> }>
  onExecute?: (action: Record<string, unknown>) => unknown
}

function mockAgent(over: Partial<MockAgent> = {}): MockAgent {
  const m: MockAgent = { caps: [], window: 'Page - Google Chrome', calls: [], ...over }
  const bridge = {
    hasCapability: (name: string) => m.caps.includes(name),
    activeWindow: async () => m.window,
    execute: async (action: Record<string, unknown>) => {
      m.calls.push({ cmd: 'execute', action })
      return m.onExecute?.(action) ?? null
    },
    request: async (cmd: string, args?: Record<string, unknown>) => {
      m.calls.push({ cmd, action: args })
      return {}
    }
  }
  setAgent(bridge as unknown as AgentBridge)
  return m
}

const executed = (m: MockAgent): Array<Record<string, unknown> | undefined> =>
  m.calls.filter((c) => c.cmd === 'execute').map((c) => c.action)

describe('executeActions', () => {
  beforeEach(() => {
    openExternal.mockClear()
    refineTarget.mockClear()
    refineAvailable = false
  })
  afterEach(() => {
    setAgent(null)
    setCurrentContext(null)
  })

  it('maps an action sequence onto agent calls', async () => {
    const m = mockAgent()
    const actions: Action[] = [
      { type: 'click', x: 100, y: 50 },
      { type: 'type', text: 'hello' },
      { type: 'hotkey', keys: ['enter'] },
      { type: 'open_url', url: 'https://example.com/' }
    ]
    const r = await executeActions(actions)
    expect(r).toEqual({
      executed: 4,
      cancelled: false,
      blocked: false,
      reachedBottom: false,
      targets: [],
      maxRisk: 'low'
    })
    expect(executed(m)).toEqual([
      { type: 'click', x: 100, y: 50 },
      { type: 'type', text: 'hello' },
      { type: 'hotkey', keys: ['enter'] },
      { type: 'focus_browser' }
    ])
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('runs uia_act and input through their own agent commands', async () => {
    const m = mockAgent()
    const r = await executeActions(
      [
        { type: 'uia_act', elementId: 'e4', action: 'toggle', description: 'Dark' },
        { type: 'input', steps: [{ t: 'move', x: 5, y: 6 }] }
      ],
      { preview: false }
    )
    expect(r.executed).toBe(2)
    expect(executed(m)).toEqual([])
    const sent = m.calls.filter((c) => c.cmd === 'uia_act' || c.cmd === 'input')
    expect(sent).toEqual([
      { cmd: 'uia_act', action: { elementId: 'e4', action: 'toggle' } },
      { cmd: 'input', action: { steps: [{ t: 'move', x: 5, y: 6 }] } }
    ])
  })

  it('turns click_bbox into a click at the bbox centre', async () => {
    const m = mockAgent()
    await executeActions([
      { type: 'click_bbox', bbox: { x: 10, y: 20, w: 100, h: 40 }, description: 'button' }
    ])
    expect(executed(m)).toEqual([{ type: 'click', x: 60, y: 40, button: 'left' }])
    expect(refineTarget).not.toHaveBeenCalled()
  })

  it('refines a low-confidence click_bbox with the zoom crop when a key is set', async () => {
    refineAvailable = true
    refineTarget.mockImplementationOnce(async (target) => ({
      target: { ...target, physRect: { x: 0, y: 2, w: 10, h: 10 }, confidence: 0.75 },
      outcome: 'moved',
      ms: 5
    }))
    const m = mockAgent()
    await executeActions([
      { type: 'click_bbox', bbox: { x: 10, y: 20, w: 100, h: 40 }, description: 'button' }
    ])
    expect(refineTarget.mock.calls[0][0]).toMatchObject({ source: 'rect', confidence: 0.55 })
    expect(refineTarget.mock.calls[0][1]).toBe('button')
    expect(executed(m)).toEqual([{ type: 'click', x: 5, y: 7, button: 'left' }])
  })

  it('asks before clicking when the target stays uncertain after refine', async () => {
    refineAvailable = true
    refineTarget.mockImplementationOnce(async (target) => ({
      target: { ...target, confidence: 0.35 },
      outcome: 'not-found',
      ms: 5
    }))
    const { setStatus } = await import('../src/main/windows/status')
    const m = mockAgent()
    await executeActions(
      [{ type: 'click', x: 100, y: 50 }].map((a) => ({
        ...a,
        type: 'click_target' as const,
        target: { kind: 'point' as const, x: 100, y: 50, frame: '1' },
        description: 'bell icon'
      }))
    )
    expect(setStatus).toHaveBeenCalledWith(
      'acting',
      expect.stringContaining('is it this one?'),
      undefined,
      expect.any(Number)
    )
    expect(executed(m)).toEqual([{ type: 'click', x: 100, y: 50, button: 'left' }])
  })

  it('does not refine a confident target, or when refine is off', async () => {
    refineAvailable = true
    mockAgent()
    await executeActions(
      [{ type: 'click_bbox', bbox: { x: 0, y: 0, w: 10, h: 10 }, description: 'x' }],
      { refine: false }
    )
    expect(refineTarget).not.toHaveBeenCalled()
  })

  it('stops the batch when the policy blocks an action', async () => {
    const m = mockAgent()
    const r = await executeActions([
      { type: 'click', x: 1, y: 1 },
      { type: 'open_url', url: 'javascript:alert(1)' },
      { type: 'type', text: 'never' }
    ])
    expect(r.blocked).toBe(true)
    expect(r.executed).toBe(1)
    expect(executed(m)).toEqual([{ type: 'click', x: 1, y: 1 }])
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('blocks typing into a shell window', async () => {
    const m = mockAgent({ window: 'Windows PowerShell' })
    const r = await executeActions([{ type: 'type', text: 'rm -rf' }])
    expect(r.blocked).toBe(true)
    expect(executed(m)).toEqual([])
  })

  it('stops the batch when the signal is aborted', async () => {
    const controller = new AbortController()
    const m = mockAgent({
      onExecute: () => {
        controller.abort()
        return null
      }
    })
    const r = await executeActions(
      [
        { type: 'click', x: 1, y: 1 },
        { type: 'click', x: 2, y: 2 },
        { type: 'click', x: 3, y: 3 }
      ],
      { signal: controller.signal }
    )
    expect(r.cancelled).toBe(true)
    expect(r.executed).toBe(1)
    expect(executed(m)).toHaveLength(1)
  })

  it('stops after a scroll reaches the bottom', async () => {
    const m = mockAgent({
      onExecute: (a) => (a.type === 'scroll' ? { reached_bottom: true } : null)
    })
    const r = await executeActions([
      { type: 'scroll', direction: 'down', amount: 1 },
      { type: 'click', x: 1, y: 1 }
    ])
    expect(r.reachedBottom).toBe(true)
    expect(executed(m)).toHaveLength(1)
  })

  it('holds dwell (a11y dwell controller) around the batch', async () => {
    const m = mockAgent({ caps: ['dwell'] })
    const holds: string[] = []
    const io = { holdAgent: (on: boolean) => holds.push(on ? 'hold' : 'release') }
    setDwellController(new DwellController(io as unknown as DwellIo))
    try {
      await executeActions([{ type: 'click', x: 1, y: 1 }])
    } finally {
      setDwellController(null)
    }
    expect(holds).toEqual(['hold', 'release'])
    expect(m.calls.map((c) => c.cmd)).toEqual(['execute'])
  })

  it('does not pause dwell without a dwell controller', async () => {
    const m = mockAgent({ caps: ['dwell'] })
    await executeActions([{ type: 'click', x: 1, y: 1 }])
    expect(m.calls.map((c) => c.cmd)).toEqual(['execute'])
  })

  describe('click targets resolved against the turn context', () => {
    const monitor = { id: 1, rect: { x: -1280, y: 0, w: 1280, h: 720 }, scale: 1, primary: false }
    function turn(over: Partial<QueryContext> = {}): void {
      setCurrentContext({
        frames: [
          {
            id: 'f1',
            label: '1',
            monitor,
            geometry: frameGeometryOf({ width: 1280, height: 720, monitor }),
            mime: 'image/jpeg',
            data: 'img'
          }
        ],
        foreground: { title: 'App' },
        ocr: async () => null,
        activeWindow: 'App',
        screenshot: 'img',
        at: Date.now(),
        ...over
      })
    }

    it('clicks the centre of a UIA element on the frame monitor', async () => {
      turn({
        uia: {
          snapshotId: 's1',
          root: {
            id: 'e0',
            role: 'window',
            name: 'App',
            rect: monitor.rect,
            monitorId: 1,
            enabled: true,
            patterns: [],
            children: [
              {
                id: 'e4',
                role: 'button',
                name: 'Save',
                rect: { x: -1200, y: 100, w: 100, h: 40 },
                monitorId: 1,
                enabled: true,
                patterns: ['invoke']
              }
            ]
          }
        }
      })
      const m = mockAgent()
      await executeActions([{ type: 'click_target', target: { kind: 'element', id: 'e4' } }])
      expect(executed(m)).toEqual([{ type: 'click', x: -1150, y: 120, button: 'left' }])
    })

    it('clicks a set-of-marks number', async () => {
      turn({
        marks: [
          { n: 3, physRect: { x: -600, y: 300, w: 60, h: 20 }, source: 'ocr', label: 'Render' }
        ]
      })
      const m = mockAgent()
      await executeActions([{ type: 'click_target', target: { kind: 'mark', n: 3 } }])
      expect(executed(m)).toEqual([{ type: 'click', x: -570, y: 310, button: 'left' }])
    })

    it('resolves click_nth_element with OCR in reading order', async () => {
      const w = (
        y: number
      ): {
        text: string
        rect: { x: number; y: number; w: number; h: number }
        conf: number
        lineIndex: number
      } => ({
        text: 'OxGF',
        rect: { x: -1000, y, w: 80, h: 20 },
        conf: 1,
        lineIndex: y
      })
      turn({ ocr: async () => ({ words: [w(300), w(100), w(200)], lines: [] }) })
      const m = mockAgent()
      await executeActions([{ type: 'click_nth_element', text: '0xGF', n: 2 }])
      expect(executed(m)).toEqual([{ type: 'click', x: -960, y: 210, button: 'left' }])
    })

    it('lets the agent search itself when main has no OCR for a text click', async () => {
      turn()
      const m = mockAgent()
      await executeActions([{ type: 'click_nth_element', text: 'Inbox', n: 2 }])
      expect(executed(m)).toEqual([{ type: 'click_nth_element', text: 'Inbox', n: 2 }])
    })

    it('skips a click whose target is not on screen', async () => {
      turn()
      const m = mockAgent()
      const r = await executeActions([
        { type: 'click_target', target: { kind: 'element', id: 'gone' } },
        { type: 'type', text: 'hi' }
      ])
      expect(executed(m)).toEqual([{ type: 'type', text: 'hi' }])
      expect(r.executed).toBe(1)
    })
  })
})
