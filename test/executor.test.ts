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
vi.mock('../src/main/windows/highlight', () => ({ send: vi.fn(), show: vi.fn(), hide: vi.fn() }))
vi.mock('../src/main/windows/status', () => ({ setStatus: vi.fn() }))
const findClickCoordinates = vi.fn(async () => null as { x: number; y: number } | null)
vi.mock('../src/main/ai/computer-use', () => ({
  findClickCoordinates: (...args: unknown[]) => findClickCoordinates(...(args as []))
}))
vi.mock('../src/main/ai/app-context', () => ({ isBrowser: () => true }))
vi.mock('../src/main/query/capture', () => ({ captureScreenshot: async () => 'img' }))

import type { Action } from '@shared/types'
import { executeActions } from '../src/main/actions/executor'
import { frameGeometryOf } from '../src/main/actions/coords'
import { setCurrentContext, type QueryContext } from '../src/main/query/context'
import { setAgent } from '../src/main/agent/instance'
import type { AgentBridge } from '../src/main/agent/bridge'

interface MockAgent {
  protocol: 1 | 2
  caps: string[]
  window: string
  calls: Array<{ cmd: string; action?: Record<string, unknown> }>
  onExecute?: (action: Record<string, unknown>) => unknown
}

function mockAgent(over: Partial<MockAgent> = {}): MockAgent {
  const m: MockAgent = { protocol: 1, caps: [], window: 'Page - Google Chrome', calls: [], ...over }
  const bridge = {
    get protocol() {
      return m.protocol
    },
    hasCapability: (name: string) => m.caps.includes(name),
    screenshot: async () => 'img',
    activeWindow: async () => m.window,
    execute: async (action: Record<string, unknown>) => {
      m.calls.push({ cmd: 'execute', action })
      return m.onExecute?.(action) ?? null
    },
    request: async (cmd: string) => {
      m.calls.push({ cmd })
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
    findClickCoordinates.mockClear()
    delete process.env.ANTHROPIC_API_KEY
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
    expect(r).toEqual({ executed: 4, cancelled: false, blocked: false, reachedBottom: false })
    expect(executed(m)).toEqual([
      { type: 'click', x: 100, y: 50 },
      { type: 'type', text: 'hello' },
      { type: 'hotkey', keys: ['enter'] },
      { type: 'focus_browser' }
    ])
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('turns click_bbox into a click at the bbox centre', async () => {
    const m = mockAgent()
    await executeActions([
      { type: 'click_bbox', bbox: { x: 10, y: 20, w: 100, h: 40 }, description: 'button' }
    ])
    expect(executed(m)).toEqual([{ type: 'click', x: 60, y: 40, button: 'left' }])
    expect(findClickCoordinates).not.toHaveBeenCalled()
  })

  it('refines click_bbox with Computer Use when a key is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test'
    findClickCoordinates.mockResolvedValueOnce({ x: 5, y: 6 })
    const m = mockAgent()
    await executeActions([
      { type: 'click_bbox', bbox: { x: 10, y: 20, w: 100, h: 40 }, description: 'button' }
    ])
    expect(executed(m)).toEqual([{ type: 'click', x: 5, y: 6, button: 'left' }])
  })

  it('skips refinement when refine is false', async () => {
    process.env.ANTHROPIC_API_KEY = 'test'
    mockAgent()
    await executeActions(
      [{ type: 'click_bbox', bbox: { x: 0, y: 0, w: 10, h: 10 }, description: 'x' }],
      { refine: false }
    )
    expect(findClickCoordinates).not.toHaveBeenCalled()
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

  it('pauses dwell around the batch on a v2 agent with the dwell capability', async () => {
    const m = mockAgent({ protocol: 2, caps: ['dwell'] })
    await executeActions([{ type: 'click', x: 1, y: 1 }])
    expect(m.calls.map((c) => c.cmd)).toEqual(['dwell_pause', 'execute', 'dwell_resume'])
  })

  it('does not pause dwell on a v1 agent', async () => {
    const m = mockAgent({ protocol: 1, caps: ['dwell'] })
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
