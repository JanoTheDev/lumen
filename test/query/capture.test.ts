import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/windows/highlight', () => ({ isVisible: () => false, hide: vi.fn() }))
vi.mock('../../src/main/util', () => ({ sleep: async () => {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import type { ElementNode } from '@shared/types'
import { AgentError, type AgentBridge } from '../../src/main/agent/bridge'
import { setAgent } from '../../src/main/agent/instance'
import { currentFrame, setCurrentFrame, setScreenAdapter } from '../../src/main/actions/coords'
import { captureContext } from '../../src/main/query/capture'
import {
  clearSpeculative,
  currentContext,
  setCurrentContext,
  startSpeculativeCapture,
  takeSpeculative
} from '../../src/main/query/context'
import { setDisplays, resetElectronMock } from '../helpers/electron-mock'
import { display, screenAdapterFor, type DisplayLayout } from '../helpers/displays'

// Primary 100% at 0,0; secondary 150% to its left (negative origin).
const LEFT_150: DisplayLayout = {
  name: 'primary 100% + 150% left',
  displays: [
    display('primary', { x: 0, y: 0, width: 1920, height: 1080 }, 1, { x: 0, y: 0 }, true),
    display('left', { x: -2880, y: 0, width: 2880, height: 1800 }, 1.5, { x: -1920, y: 0 })
  ]
}

const LEFT_MONITOR = {
  id: 0,
  rect: { x: -2880, y: 0, w: 2880, h: 1800 },
  scale: 1.5,
  primary: false
}

function node(id: string, role: string, name: string, x: number, y: number): ElementNode {
  return {
    id,
    role,
    name,
    rect: { x, y, w: 80, h: 30 },
    monitorId: 0,
    enabled: true,
    patterns: ['invoke']
  }
}

const UIA = {
  snapshotId: 's1',
  root: {
    ...node('e0', 'window', 'Editor', -2880, 0),
    rect: { x: -2880, y: 0, w: 2880, h: 1800 },
    children: [1, 2, 3, 4, 5, 6].map((i) => node(`e${i}`, 'button', `B${i}`, -2800 + i * 100, 40))
  }
}

// Five big named buttons covering the window: quality "good", so no set-of-marks.
const GOOD_UIA = {
  snapshotId: 's2',
  root: {
    ...node('e0', 'window', 'Editor', -2880, 0),
    rect: { x: -2880, y: 0, w: 2880, h: 1800 },
    children: [0, 1, 2, 3, 4].map((i) => ({
      ...node(`e${i + 1}`, 'button', `Big ${i}`, -2880, i * 360),
      rect: { x: -2880, y: i * 360, w: 2880, h: 350 }
    }))
  }
}

interface FakeAgent {
  calls: { cmd: string; args: Record<string, unknown> }[]
  results: Record<string, unknown>
}

function fakeAgent(results: Record<string, unknown>, delayMs = 0): FakeAgent {
  const fake: FakeAgent = { calls: [], results }
  const bridge = {
    protocol: 1,
    hasCapability: () => false,
    request: async (cmd: string, args: Record<string, unknown> = {}) => {
      fake.calls.push({ cmd, args })
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (!(cmd in fake.results)) throw new AgentError('E_AGENT_CMD', `Unknown command: ${cmd}`)
      return fake.results[cmd]
    }
  }
  setAgent(bridge as unknown as AgentBridge)
  return fake
}

beforeEach(() => {
  resetElectronMock()
  setDisplays(LEFT_150)
  setScreenAdapter(screenAdapterFor(LEFT_150))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  setAgent(null)
  setScreenAdapter(null)
  setCurrentFrame(null)
  setCurrentContext(null)
  clearSpeculative()
  vi.restoreAllMocks()
})

describe('captureContext', () => {
  it('captures the foreground monitor with its geometry, UIA and window title', async () => {
    const fake = fakeAgent({
      active_window: 'main.ts - Visual Studio Code',
      capture: {
        frames: [
          {
            id: 'f7',
            monitor: LEFT_MONITOR,
            width: 1280,
            height: 800,
            scale: 2.25,
            mime: 'image/jpeg',
            data: 'IMG'
          }
        ]
      },
      uia_snapshot: UIA
    })
    const ctx = await captureContext(true)
    expect(ctx.activeWindow).toBe('main.ts - Visual Studio Code')
    expect(ctx.screenshot).toBe('IMG')
    expect(ctx.frames[0]).toMatchObject({ id: 'f7', label: '1', monitor: LEFT_MONITOR })
    expect(ctx.frames[0].geometry).toEqual({
      originX: -2880,
      originY: 0,
      width: 2880,
      height: 1800,
      imgW: 1280,
      imgH: 800
    })
    expect(ctx.uia?.snapshotId).toBe('s1')
    expect(ctx.uiaQuality).toBe('partial')
    expect(ctx.foreground.rect).toEqual(UIA.root.rect)
    expect(fake.calls.find((c) => c.cmd === 'capture')?.args).toMatchObject({
      monitor: 'foreground'
    })
    // The executor and presenter now convert with this frame.
    expect(currentFrame()).toEqual(ctx.frames[0].geometry)
    expect(currentContext()).toBe(ctx)
  })

  it('never changes focus: no input or focus commands while capturing (text_insert keeps Word in front)', async () => {
    const fake = fakeAgent({
      active_window: 'Document1 - Word',
      capture: {
        frames: [
          {
            id: 'f1',
            monitor: LEFT_MONITOR,
            width: 1280,
            height: 800,
            mime: 'image/jpeg',
            data: 'x'
          }
        ]
      }
    })
    await captureContext(true)
    // No UIA here, so OCR runs for set-of-marks; nothing that moves focus or types.
    expect(fake.calls.map((c) => c.cmd).sort()).toEqual([
      'active_window',
      'capture',
      'ocr',
      'uia_snapshot'
    ])
  })

  it('falls back to the v1 screenshot on the primary display', async () => {
    fakeAgent({ active_window: 'Notepad', screenshot: '/9j/' })
    const ctx = await captureContext(true)
    expect(ctx.screenshot).toBe('/9j/')
    expect(ctx.frames[0].monitor).toBeUndefined()
    expect(ctx.frames[0].geometry).toMatchObject({
      originX: 0,
      originY: 0,
      width: 1920,
      height: 1080
    })
    expect(ctx.uia).toBeUndefined()
    await expect(ctx.ocr()).resolves.toBeNull()
  })

  it('runs OCR lazily, once, on the captured frame', async () => {
    const ocr = { words: [], lines: [{ text: 'Save', rect: { x: 1, y: 2, w: 3, h: 4 }, conf: 1 }] }
    const fake = fakeAgent({
      active_window: 'x',
      capture: {
        frames: [
          {
            id: 'f9',
            monitor: LEFT_MONITOR,
            width: 1280,
            height: 800,
            mime: 'image/jpeg',
            data: 'x'
          }
        ]
      },
      uia_snapshot: GOOD_UIA,
      ocr
    })
    const ctx = await captureContext(true)
    expect(ctx.uiaQuality).toBe('good')
    expect(fake.calls.some((c) => c.cmd === 'ocr')).toBe(false)
    await expect(ctx.ocr()).resolves.toEqual(ocr)
    await ctx.ocr()
    const ocrCalls = fake.calls.filter((c) => c.cmd === 'ocr')
    expect(ocrCalls).toEqual([{ cmd: 'ocr', args: { frameId: 'f9' } }])
  })

  it('draws set-of-marks when UIA is poor and keeps the marks table for the turn', async () => {
    const fake = fakeAgent({
      active_window: 'Blender',
      capture: {
        frames: [
          {
            id: 'f4',
            monitor: LEFT_MONITOR,
            width: 1280,
            height: 800,
            mime: 'image/jpeg',
            data: 'RAW'
          }
        ]
      },
      uia_snapshot: UIA,
      ocr: {
        words: [],
        lines: [
          { text: 'Render', rect: { x: -2000, y: 300, w: 160, h: 40 }, conf: 1 },
          { text: 'File', rect: { x: -2860, y: 300, w: 80, h: 40 }, conf: 1 }
        ]
      },
      marks_render: { data: 'MARKED', width: 1280, height: 800, mime: 'image/jpeg', count: 2 }
    })
    const ctx = await captureContext(true)
    expect(ctx.uiaQuality).toBe('partial')
    expect(ctx.screenshot).toBe('MARKED')
    expect(ctx.frames[0].data).toBe('RAW')
    expect(ctx.marks?.map((m) => [m.n, m.label])).toEqual([
      [1, 'File'],
      [2, 'Render']
    ])
    const render = fake.calls.find((c) => c.cmd === 'marks_render')
    expect(render?.args).toMatchObject({
      frameId: 'f4',
      marks: [
        { n: 1, rect: { x: -2860, y: 300, w: 80, h: 40 } },
        { n: 2, rect: { x: -2000, y: 300, w: 160, h: 40 } }
      ]
    })
  })

  it('sends the plain frame when the marked image has the wrong size', async () => {
    fakeAgent({
      active_window: 'Blender',
      capture: {
        frames: [
          {
            id: 'f5',
            monitor: LEFT_MONITOR,
            width: 1280,
            height: 800,
            mime: 'image/jpeg',
            data: 'RAW'
          }
        ]
      },
      ocr: {
        words: [],
        lines: [{ text: 'File', rect: { x: -2860, y: 300, w: 80, h: 40 }, conf: 1 }]
      },
      marks_render: { data: 'MARKED', width: 640, height: 400, mime: 'image/jpeg', count: 1 }
    })
    const ctx = await captureContext(true)
    expect(ctx.screenshot).toBe('RAW')
    expect(ctx.marks).toBeUndefined()
  })

  it('a query arriving before the speculative capture finishes awaits the same capture', async () => {
    const fake = fakeAgent(
      {
        active_window: 'x',
        capture: {
          frames: [
            {
              id: 'f1',
              monitor: LEFT_MONITOR,
              width: 1280,
              height: 800,
              mime: 'image/jpeg',
              data: 'x'
            }
          ]
        }
      },
      20
    )
    startSpeculativeCapture(() => captureContext(true))
    const pending = takeSpeculative()
    expect(pending).not.toBeNull()
    const ctx = await pending!
    expect(ctx.frames).toHaveLength(1)
    expect(fake.calls.filter((c) => c.cmd === 'capture')).toHaveLength(1)
  })

  it('without a screenshot only asks for the window', async () => {
    const fake = fakeAgent({ active_window: 'Calculator' })
    const ctx = await captureContext(false)
    expect(ctx).toMatchObject({ activeWindow: 'Calculator', screenshot: null, frames: [] })
    expect(fake.calls.map((c) => c.cmd)).toEqual(['active_window'])
  })
})
