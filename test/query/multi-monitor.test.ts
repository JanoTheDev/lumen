import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import type { MonitorInfo } from '@shared/types'
import { frameGeometryOf } from '../../src/main/actions/coords'
import { callModel } from '../../src/main/ai'
import { userTurn } from '../../src/main/ai/prompts/assemble'
import { setProvider } from '../../src/main/ai/providers'
import type { ChatChunk, LlmProvider, StructuredRequest } from '../../src/main/ai/providers/types'
import { lazyOcr, type Frame, type QueryContext } from '../../src/main/query/context'
import { mentionsOtherScreen, normalizeRoute, type Route } from '../../src/main/query/router'
import { orderFrames, screenNames } from '../../src/main/query/screens'

// Primary 1920x1080 @100% at 0,0; second monitor 2880x1800 @150% to the left (negative x).
const PRIMARY: MonitorInfo = {
  id: 1,
  rect: { x: 0, y: 0, w: 1920, h: 1080 },
  scale: 1,
  primary: true
}
const LEFT: MonitorInfo = {
  id: 2,
  rect: { x: -2880, y: 0, w: 2880, h: 1800 },
  scale: 1.5,
  primary: false
}

function frame(label: string, monitor: MonitorInfo, w: number, h: number): Frame {
  return {
    id: `f${monitor.id}`,
    label,
    monitor,
    geometry: frameGeometryOf({ width: w, height: h, monitor }),
    mime: 'image/jpeg',
    data: `IMG${monitor.id}`
  }
}

describe('frame order and names', () => {
  it('puts the foreground monitor first and relabels the rest by position', () => {
    const captured = [frame('1', PRIMARY, 1280, 720), frame('2', LEFT, 1280, 800)]
    const onLeft = orderFrames(captured, LEFT.id)
    expect(onLeft.map((f) => [f.label, f.monitor?.id])).toEqual([
      ['1', 2],
      ['2', 1]
    ])
    expect(orderFrames(captured, PRIMARY.id).map((f) => f.monitor?.id)).toEqual([1, 2])
    // Unknown foreground monitor: left to right.
    expect(orderFrames(captured, undefined).map((f) => f.monitor?.id)).toEqual([2, 1])
  })

  it('names screens with primary and position', () => {
    const frames = orderFrames([frame('1', PRIMARY, 1280, 720), frame('2', LEFT, 1280, 800)], 2)
    const names = screenNames(frames)
    expect(names.get('1')).toBe('Screen 1 (left)')
    expect(names.get('2')).toBe('Screen 2 (primary, right)')
    const stacked: MonitorInfo = { ...LEFT, rect: { x: 0, y: -1440, w: 2560, h: 1440 } }
    const vertical = screenNames([frame('1', PRIMARY, 1280, 720), frame('2', stacked, 1280, 720)])
    expect(vertical.get('1')).toBe('Screen 1 (primary, bottom)')
    expect(vertical.get('2')).toBe('Screen 2 (top)')
    expect(screenNames([frame('1', PRIMARY, 1280, 720)]).get('1')).toBe('Screen 1 (primary)')
  })

  it('the user turn lists every frame when several are sent', () => {
    const turn = userTurn({
      prompt: 'what is on my other screen',
      activeWindow: 'Notepad',
      frame: { w: 1280, h: 800 },
      screens: [
        { label: '1', name: 'Screen 1 (left)', w: 1280, h: 800 },
        { label: '2', name: 'Screen 2 (primary, right)', w: 1280, h: 720 }
      ]
    })
    expect(turn).toContain(
      'screens: frame "1" = Screen 1 (left), 1280x800 px; frame "2" = Screen 2 (primary, right), 1280x720 px.'
    )
    expect(turn).not.toContain('screen: frame "1"')
  })
})

describe('router: other screens', () => {
  const base: Route = {
    mode: 'describe',
    needsScreen: false,
    needsUia: false,
    appSwitch: false,
    confidence: 0.9
  }

  it('needsAllScreens forces the screen and is dropped when false', () => {
    expect(normalizeRoute({ ...base, mode: 'answer', needsAllScreens: true })).toMatchObject({
      needsScreen: true,
      needsAllScreens: true
    })
    expect(normalizeRoute({ ...base, needsAllScreens: false })).not.toHaveProperty(
      'needsAllScreens'
    )
  })

  it('recognises phrases naming another monitor', () => {
    for (const u of [
      "what's on my other screen",
      'read the second monitor',
      'compare both screens',
      'click OK on the left display'
    ])
      expect(mentionsOtherScreen(u)).toBe(true)
    for (const u of ['take a screenshot', 'what is on screen', 'monitor my cpu'])
      expect(mentionsOtherScreen(u)).toBe(false)
  })
})

describe('callModel with two monitors', () => {
  const key = process.env.ANTHROPIC_API_KEY
  let seen: StructuredRequest<unknown> | null = null

  const provider: LlmProvider = {
    id: 'anthropic',
    async *stream(req): AsyncIterable<ChatChunk> {
      seen = req
      const text = JSON.stringify({
        response: {
          mode: 'locate',
          spoken: 'It is on your right screen.',
          items: [
            { label: 'OK', target: { kind: 'rect', x: 600, y: 300, w: 80, h: 40, frame: '2' } }
          ]
        }
      })
      yield { type: 'text', text }
      yield {
        type: 'done',
        result: {
          text,
          model: 'claude-sonnet-5-5',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      }
    },
    complete: vi.fn(),
    warmup: async () => {}
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    setProvider('anthropic', provider)
  })
  afterEach(() => {
    setProvider('anthropic', null)
    process.env.ANTHROPIC_API_KEY = key
    vi.restoreAllMocks()
  })

  it('sends frame "1" (with marks) then the other monitor, labelled, and keeps the frame on targets', async () => {
    const frames = orderFrames([frame('1', PRIMARY, 1280, 720), frame('2', LEFT, 1280, 800)], 2)
    const ctx: QueryContext = {
      frames,
      foreground: { title: 'Notepad', monitorId: 2 },
      ocr: lazyOcr(async () => null),
      activeWindow: 'Notepad',
      screenshot: 'MARKED2',
      at: Date.now()
    }
    const r = await callModel('where is OK on my other screen', 'MARKED2', 'Notepad', {
      context: ctx,
      history: false
    })
    expect(seen?.images?.map((i) => i.base64)).toEqual(['MARKED2', 'IMG1'])
    expect(seen?.messages.at(-1)?.content).toContain('frame "2" = Screen 2 (primary, right)')
    expect(r.mode).toBe('locate')
    expect((r as { items?: { target?: unknown }[] }).items?.[0].target).toMatchObject({
      kind: 'rect',
      frame: '2'
    })
  })
})
