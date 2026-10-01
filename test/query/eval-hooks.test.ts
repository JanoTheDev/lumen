import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import { setScreenAdapter } from '../../src/main/actions/coords'
import { groundOnly, routeOnly, setDeterministic } from '../../src/main/query/eval-hooks'
import { setProvider } from '../../src/main/ai/providers'
import type {
  ChatChunk,
  CompleteResult,
  StructuredRequest
} from '../../src/main/ai/providers/types'
import { display, screenAdapterFor } from '../helpers/displays'

afterEach(() => setScreenAdapter(null))

describe('groundOnly', () => {
  it('resolves the picked target against a recorded frame, headless', async () => {
    setScreenAdapter(
      screenAdapterFor({
        name: '150%',
        displays: [
          display('m', { x: 0, y: 0, width: 2880, height: 1800 }, 1.5, { x: 0, y: 0 }, true)
        ]
      })
    )
    const monitor = { id: 0, rect: { x: 0, y: 0, w: 2880, h: 1800 }, scale: 1.5, primary: true }
    const uia = {
      snapshotId: 's',
      root: {
        id: 'e0',
        role: 'window',
        name: 'Mail',
        rect: monitor.rect,
        monitorId: 0,
        enabled: true,
        patterns: [],
        children: [
          {
            id: 'e1',
            role: 'button',
            name: 'Compose',
            rect: { x: 30, y: 270, w: 210, h: 90 },
            monitorId: 0,
            enabled: true,
            patterns: ['invoke' as const]
          }
        ]
      }
    }
    const pick = vi.fn(async () => ({ kind: 'element' as const, id: 'e1' }))
    const r = await groundOnly(
      { data: 'jpg', width: 1280, height: 800, monitor },
      uia,
      undefined,
      'click compose',
      pick
    )
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'click compose',
        elements: 'e1 button "Compose" @(13,120,93,40)'
      })
    )
    expect(r).toMatchObject({ elementId: 'e1', logicalRect: { x: 20, y: 180, w: 140, h: 60 } })
  })
})

describe('routeOnly', () => {
  const key = process.env.ANTHROPIC_API_KEY
  afterEach(() => {
    setProvider('anthropic', null)
    setDeterministic(false)
    process.env.ANTHROPIC_API_KEY = key
  })

  it('answers prefilter commands locally and the rest through the router at temperature 0', async () => {
    expect(await routeOnly('cancel')).toEqual({ stage: 'prefilter', hit: { kind: 'cancel' } })
    expect(await routeOnly('next', { guideActive: true })).toMatchObject({
      stage: 'prefilter',
      hit: { kind: 'guide-nav' }
    })

    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const seen: StructuredRequest<unknown>[] = []
    const route = {
      mode: 'locate',
      needsScreen: true,
      needsUia: true,
      appSwitch: false,
      confidence: 0.9
    }
    setProvider('anthropic', {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ChatChunk> {
        throw new Error('not streamed')
      },
      complete: async <T>(req: StructuredRequest<T>): Promise<CompleteResult<T>> => {
        seen.push(req as StructuredRequest<unknown>)
        return {
          text: JSON.stringify(route),
          data: route as T,
          model: req.model,
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      },
      warmup: async () => {}
    })
    const r = await routeOnly(
      'where is the compose button',
      { foreground: 'Inbox - Gmail' },
      { deterministic: true }
    )
    expect(r).toMatchObject({ stage: 'router', route: { mode: 'locate' } })
    expect(seen[0].temperature).toBe(0)
    expect(seen[0].messages[0].content).toContain('Inbox - Gmail')
  })
})
