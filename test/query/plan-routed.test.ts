// 12 01 T3: the screen capture runs while the router decides, so a turn that turns out to need
// the screen waits max(router, capture) instead of their sum. A capture the route does not use
// is never published or sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
const layer = vi.hoisted(() => ({ visible: false }))
vi.mock('../../src/main/windows/highlight', () => ({
  send: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  clear: vi.fn(),
  isVisible: () => layer.visible
}))
vi.mock('../../src/main/windows/answer', () => ({
  showText: vi.fn(),
  send: vi.fn(),
  hide: vi.fn()
}))
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn() }))
vi.mock('../../src/main/guides/session', () => ({
  guideState: () => ({ guideActive: false, hasLastGuide: false })
}))
vi.mock('../../src/main/config', async () => {
  const { makeConfig } = await import('../helpers/fixtures')
  const cfg = makeConfig()
  return { loadConfig: () => cfg }
})

const ROUTER_MS = 300
const CAPTURE_MS = 200
const WINDOW_MS = 10

const fx = vi.hoisted(() => ({
  route: { needsScreen: true, mode: 'answer' } as { needsScreen: boolean; mode: string },
  routerInput: null as null | { activeWindow: string | null },
  routerDoneAt: 0,
  captures: [] as {
    at: number
    withScreenshot: boolean
    opts: { allScreens?: boolean; signal?: AbortSignal; publish?: Promise<boolean> }
    published?: boolean
  }[]
}))

vi.mock('../../src/main/query/router', async (orig) => ({
  ...(await orig<typeof import('../../src/main/query/router')>()),
  routeWithLlm: async (input: { activeWindow: string | null }) => {
    fx.routerInput = input
    await new Promise((r) => setTimeout(r, ROUTER_MS))
    fx.routerDoneAt = Date.now()
    return {
      mode: fx.route.mode,
      needsScreen: fx.route.needsScreen,
      needsUia: false,
      appSwitch: false,
      confidence: 0.9
    }
  }
}))

vi.mock('../../src/main/query/capture', () => ({
  captureContext: async (
    withScreenshot: boolean,
    opts: { allScreens?: boolean; signal?: AbortSignal; publish?: Promise<boolean> } = {}
  ) => {
    const call: (typeof fx.captures)[number] = { at: Date.now(), withScreenshot, opts }
    fx.captures.push(call)
    await new Promise((r) => setTimeout(r, CAPTURE_MS))
    if (opts.publish) call.published = await opts.publish
    return {
      frames: [],
      foreground: { title: 'Notepad' },
      ocr: async () => null,
      activeWindow: 'Notepad',
      screenshot: 'IMG',
      at: Date.now()
    }
  },
  captureScreenshot: async () => 'IMG'
}))

import { CancelScope } from '../../src/main/query/cancel'
import { planRouted } from '../../src/main/query/pipeline'
import { clearSpeculative } from '../../src/main/query/context'
import { setAgent } from '../../src/main/agent/instance'
import type { AgentBridge } from '../../src/main/agent/bridge'

const agentCalls: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  fx.route = { needsScreen: true, mode: 'answer' }
  fx.routerInput = null
  fx.routerDoneAt = 0
  fx.captures = []
  layer.visible = false
  agentCalls.length = 0
  clearSpeculative()
  setAgent({
    activeWindow: async () => {
      agentCalls.push('activeWindow')
      await new Promise((r) => setTimeout(r, WINDOW_MS))
      return 'Notepad'
    }
  } as unknown as AgentBridge)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  setAgent(null)
  vi.restoreAllMocks()
})

async function plan(prompt: string): Promise<{
  result: Awaited<ReturnType<typeof planRouted>>
  ms: number
  t0: number
}> {
  const t0 = Date.now()
  const p = planRouted(prompt, {}, new CancelScope())
  await vi.runAllTimersAsync()
  const result = await p
  return { result, ms: Date.now() - t0, t0 }
}

describe('planRouted', () => {
  it('captures while the router decides: max(router, capture), not the sum', async () => {
    // No screen word, so the keyword check alone would not capture.
    const { result, ms, t0 } = await plan('how tall is the eiffel tower')
    expect(fx.captures).toHaveLength(1)
    expect(fx.captures[0].withScreenshot).toBe(true)
    expect(fx.captures[0].at - t0).toBeLessThan(fx.routerDoneAt - t0)
    expect(fx.captures[0].published).toBe(true)
    expect(result.ctx.screenshot).toBe('IMG')
    expect(fx.routerInput?.activeWindow).toBe('Notepad')
    expect(ms).toBe(WINDOW_MS + ROUTER_MS)
  })

  it('a screen word captures in parallel as before', async () => {
    const { result, ms } = await plan('what is on my screen')
    expect(fx.captures).toHaveLength(1)
    expect(result.ctx.screenshot).toBe('IMG')
    expect(ms).toBe(WINDOW_MS + ROUTER_MS)
  })

  it('drops the capture unpublished and stopped when the route needs no screen', async () => {
    fx.route = { needsScreen: false, mode: 'answer' }
    const { result, ms } = await plan('how tall is the eiffel tower')
    expect(result.ctx.screenshot).toBeNull()
    expect(result.ctx.frames).toEqual([])
    expect(result.ctx.activeWindow).toBe('Notepad')
    expect(fx.captures).toHaveLength(1)
    expect(fx.captures[0].published).toBe(false)
    expect(fx.captures[0].opts.signal?.aborted).toBe(true)
    expect(ms).toBe(WINDOW_MS + ROUTER_MS)
  })

  it('does not capture early while the overlay is up', async () => {
    layer.visible = true
    const { result, ms } = await plan('how tall is the eiffel tower')
    expect(fx.captures).toHaveLength(1)
    expect(fx.captures[0].opts.publish).toBeUndefined()
    expect(result.ctx.screenshot).toBe('IMG')
    expect(ms).toBe(WINDOW_MS + ROUTER_MS + CAPTURE_MS)
  })

  it('a pure launch does not capture while routing', async () => {
    fx.route = { needsScreen: false, mode: 'action' }
    const { result } = await plan('open spotify')
    expect(fx.captures).toHaveLength(0)
    expect(result.ctx.screenshot).toBeNull()
  })

  it('a launch the route says needs the screen captures afterwards', async () => {
    fx.route = { needsScreen: true, mode: 'action' }
    const { result, ms } = await plan('open spotify')
    expect(fx.captures).toHaveLength(1)
    expect(fx.captures[0].opts.publish).toBeUndefined()
    expect(result.ctx.screenshot).toBe('IMG')
    expect(ms).toBe(WINDOW_MS + ROUTER_MS + CAPTURE_MS)
  })
})
