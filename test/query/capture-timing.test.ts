// 12 01 T6: the frame is read (OCR) while the UIA snapshot still runs, so a poor-UIA capture
// takes about max(UIA, capture + OCR) + render instead of UIA + OCR + render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/windows/highlight', () => ({
  isVisible: () => false,
  hide: vi.fn(),
  holdHidden: () => () => {}
}))
vi.mock('../../src/main/util', () => ({ sleep: async () => {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import type { ElementNode } from '@shared/types'
import { AgentError, type AgentBridge } from '../../src/main/agent/bridge'
import { setAgent } from '../../src/main/agent/instance'
import { currentFrame, setCurrentFrame, setScreenAdapter } from '../../src/main/actions/coords'
import { captureContext } from '../../src/main/query/capture'
import { setSkillsDir } from '../../src/main/ai/skills'
import { join } from 'path'
import { currentContext, setCurrentContext } from '../../src/main/query/context'
import { setDisplays, resetElectronMock } from '../helpers/electron-mock'
import { display, screenAdapterFor, type DisplayLayout } from '../helpers/displays'

const PRIMARY: DisplayLayout = {
  name: 'primary 100%',
  displays: [display('primary', { x: 0, y: 0, width: 1920, height: 1080 }, 1, { x: 0, y: 0 }, true)]
}
const MONITOR = { id: 0, rect: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1, primary: true }

function node(id: string, name: string, rect: ElementNode['rect']): ElementNode {
  return { id, role: 'button', name, rect, monitorId: 0, enabled: true, patterns: ['invoke'] }
}

// A few small buttons: quality "partial", so set-of-marks runs.
const PARTIAL_UIA = {
  snapshotId: 's1',
  root: {
    ...node('e0', 'Editor', { x: 0, y: 0, w: 1920, h: 1080 }),
    role: 'window',
    children: [1, 2, 3, 4, 5, 6].map((i) =>
      node(`e${i}`, `B${i}`, { x: 100 + i * 100, y: 40, w: 80, h: 30 })
    )
  }
}
// Five big named buttons covering the window: quality "good", no set-of-marks.
const GOOD_UIA = {
  snapshotId: 's2',
  root: {
    ...node('e0', 'Editor', { x: 0, y: 0, w: 1920, h: 1080 }),
    role: 'window',
    children: [0, 1, 2, 3, 4].map((i) =>
      node(`e${i + 1}`, `Big ${i}`, { x: 0, y: i * 216, w: 1920, h: 210 })
    )
  }
}

const FRAME = {
  id: 'f1',
  monitor: MONITOR,
  width: 1280,
  height: 720,
  mime: 'image/jpeg',
  data: 'RAW'
}

function fakeAgent(
  results: Record<string, unknown>,
  delays: Record<string, number>
): { calls: { cmd: string; at: number }[] } {
  const fake = { calls: [] as { cmd: string; at: number }[] }
  const bridge = {
    hasCapability: () => true,
    request: async (cmd: string) => {
      fake.calls.push({ cmd, at: Date.now() })
      const ms = delays[cmd] ?? 0
      if (ms) await new Promise((r) => setTimeout(r, ms))
      if (!(cmd in results)) throw new AgentError('E_UNSUPPORTED', `no result for ${cmd}`)
      return results[cmd]
    }
  }
  setAgent(bridge as unknown as AgentBridge)
  return fake
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  const p = run()
  await vi.runAllTimersAsync()
  const value = await p
  return { value, ms: Date.now() - t0 }
}

beforeEach(() => {
  vi.useFakeTimers()
  setSkillsDir(join(__dirname, 'no-skills'))
  resetElectronMock()
  setDisplays(PRIMARY)
  setScreenAdapter(screenAdapterFor(PRIMARY))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  setAgent(null)
  setScreenAdapter(null)
  setCurrentFrame(null)
  setCurrentContext(null)
  vi.restoreAllMocks()
})

describe('captureContext timing', () => {
  it('reads the frame while the UIA snapshot runs (poor UIA)', async () => {
    const fake = fakeAgent(
      {
        active_window: { title: 'Editor', monitor: 0 },
        capture: { frames: [FRAME] },
        uia_snapshot: PARTIAL_UIA,
        ocr: {
          words: [],
          lines: [{ text: 'File', rect: { x: 20, y: 300, w: 80, h: 40 }, conf: 1 }]
        },
        marks_render: { data: 'MARKED', width: 1280, height: 720, mime: 'image/jpeg', count: 1 }
      },
      { active_window: 5, capture: 30, uia_snapshot: 300, ocr: 200, marks_render: 50 }
    )
    const t0 = Date.now()
    const { value: ctx, ms } = await timed(() => captureContext(true))
    expect(ctx.uiaQuality).toBe('partial')
    expect(ctx.screenshot).toBe('MARKED')
    expect(ctx.marks?.map((m) => m.label)).toEqual(['File'])
    // max(UIA 300, capture 30 + OCR 200) + render 50, not 300 + 200 + 50.
    expect(ms).toBe(350)
    const ocrCalls = fake.calls.filter((c) => c.cmd === 'ocr')
    expect(ocrCalls).toHaveLength(1)
    expect(ocrCalls[0].at - t0).toBe(30)
    // The OCR is shared: later reads reuse it.
    await ctx.ocr()
    expect(fake.calls.filter((c) => c.cmd === 'ocr')).toHaveLength(1)
  })

  it('does not read the frame when good UIA came back before the frame', async () => {
    const fake = fakeAgent(
      {
        active_window: { title: 'Editor', monitor: 0 },
        capture: { frames: [FRAME] },
        uia_snapshot: GOOD_UIA,
        ocr: { words: [], lines: [] }
      },
      { capture: 60, uia_snapshot: 20 }
    )
    const { value: ctx, ms } = await timed(() => captureContext(true))
    expect(ctx.uiaQuality).toBe('good')
    expect(ms).toBe(60)
    expect(fake.calls.some((c) => c.cmd === 'ocr')).toBe(false)
  })

  it('a good snapshot that comes back after the frame still finds the OCR started', async () => {
    const fake = fakeAgent(
      {
        active_window: { title: 'Editor', monitor: 0 },
        capture: { frames: [FRAME] },
        uia_snapshot: GOOD_UIA,
        ocr: { words: [], lines: [] }
      },
      { capture: 20, uia_snapshot: 100, ocr: 50 }
    )
    const { value: ctx, ms } = await timed(() => captureContext(true))
    expect(ctx.uiaQuality).toBe('good')
    expect(ctx.marks).toBeUndefined()
    expect(ms).toBe(100)
    await ctx.ocr()
    expect(fake.calls.filter((c) => c.cmd === 'ocr')).toHaveLength(1)
  })
})

describe('captureContext publish', () => {
  const results = (): Record<string, unknown> => ({
    active_window: { title: 'Editor', monitor: 0 },
    capture: { frames: [FRAME] },
    uia_snapshot: GOOD_UIA
  })

  it('publishes the frame and context only once told to', async () => {
    fakeAgent(results(), { capture: 20 })
    let decide: (use: boolean) => void = () => {}
    const publish = new Promise<boolean>((r) => (decide = r))
    const p = captureContext(true, { publish })
    await vi.advanceTimersByTimeAsync(50)
    expect(currentContext()).toBeNull()
    decide(true)
    const ctx = await p
    expect(currentContext()).toBe(ctx)
    expect(currentFrame()).toEqual(ctx.frames[0].geometry)
  })

  it('an unused capture is returned but never becomes the current context', async () => {
    fakeAgent(results(), { capture: 20 })
    const ctx = await timed(() => captureContext(true, { publish: Promise.resolve(false) }))
    expect(ctx.value.screenshot).toBe('RAW')
    expect(currentContext()).toBeNull()
  })
})
