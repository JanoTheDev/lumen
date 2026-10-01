// T17: a turn cancelled at any stage has no side effects: no agent input, no TTS, no
// highlights or answer card, no history, and `query.cancelled` instead of `query.done`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ModelResponse } from '@shared/types'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
const ui = vi.hoisted(() => ({
  highlight: {
    send: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    clear: vi.fn(),
    isVisible: () => false
  },
  answer: { showText: vi.fn(), send: vi.fn(), hide: vi.fn() },
  status: { setStatus: vi.fn() }
}))
vi.mock('../../src/main/windows/highlight', () => ui.highlight)
vi.mock('../../src/main/windows/answer', () => ui.answer)
vi.mock('../../src/main/windows/status', () => ui.status)
vi.mock('../../src/main/guides/session', () => ({
  guideState: () => ({ guideActive: false, hasLastGuide: false })
}))
vi.mock('../../src/main/config', async () => {
  const { makeConfig } = await import('../helpers/fixtures')
  const cfg = makeConfig({ voice: { tts: 'cloud' } })
  return { loadConfig: () => cfg }
})

type Hook = (scope: CancelScope) => void
const hooks = vi.hoisted(() => ({
  route: null as Hook | null,
  capture: null as Hook | null,
  model: null as Hook | null,
  reply: null as ModelResponse | null,
  scope: null as CancelScope | null
}))
vi.mock('../../src/main/query/router', async (orig) => ({
  ...(await orig<typeof import('../../src/main/query/router')>()),
  routeWithLlm: async () => {
    if (hooks.scope) hooks.route?.(hooks.scope)
    return {
      mode: hooks.reply?.mode ?? 'answer',
      needsScreen: true,
      needsUia: false,
      appSwitch: false,
      confidence: 0.9
    }
  }
}))
vi.mock('../../src/main/query/capture', async () => {
  const { frameGeometryOf } = await import('../../src/main/actions/coords')
  return {
    captureContext: async (): Promise<QueryContext> => {
      if (hooks.scope) hooks.capture?.(hooks.scope)
      const geometry = frameGeometryOf({ width: 1280, height: 720, mime: 'image/jpeg', data: 'x' })
      return {
        frames: [{ id: 'f1', label: '1', geometry, mime: 'image/jpeg', data: 'img' }],
        foreground: { title: 'Inbox - Gmail' },
        ocr: async () => {
          // OCR runs while the locate target resolves: cancel the turn right then.
          if (hooks.scope) hooks.scope.cancel()
          return {
            words: [{ text: 'Compose', rect: { x: 10, y: 10, w: 80, h: 20 }, conf: 95 }],
            lines: [{ text: 'Compose', rect: { x: 10, y: 10, w: 80, h: 20 }, conf: 95 }]
          }
        },
        activeWindow: 'Inbox - Gmail',
        screenshot: 'img',
        at: Date.now()
      }
    },
    captureScreenshot: async () => 'img'
  }
})
const calls = vi.hoisted(() => ({ model: 0 }))
vi.mock('../../src/main/ai', () => ({
  callModel: async (): Promise<ModelResponse> => {
    calls.model++
    if (hooks.scope) hooks.model?.(hooks.scope)
    return hooks.reply ?? { mode: 'answer', text: 'Hi', spoken: 'Hi' }
  }
}))
const agentTask = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/main/agent-mode/session', () => ({
  hasPausedTask: () => false,
  isResumeRequest: () => false,
  resumeAgentTask: () => null,
  // The follow-up continues as an agent task; the user cancels while it runs.
  runAgentTask: async () => {
    agentTask.calls++
    hooks.scope?.cancel()
    throw new CancelledError()
  }
}))
vi.mock('../../src/main/ai/observe', async (orig) => ({
  ...(await orig<typeof import('../../src/main/ai/observe')>()),
  waitForSettle: async () => ({ reason: 'frames', ms: 0 })
}))

import { CancelScope, CancelledError } from '../../src/main/query/cancel'
import type { QueryContext } from '../../src/main/query/context'
import { runQuery } from '../../src/main/query/pipeline'
import { history, historyMessages } from '../../src/main/ai/history'
import { setAgent } from '../../src/main/agent/instance'
import type { AgentBridge } from '../../src/main/agent/bridge'
import { bus } from '../../src/main/bus'

const speak = vi.fn(async () => {})
const onGuide = vi.fn()
const agentCalls: string[] = []
const events: string[] = []
let off: Array<() => void> = []

function sideEffects(): number {
  return (
    speak.mock.calls.length +
    onGuide.mock.calls.length +
    ui.highlight.send.mock.calls.length +
    ui.highlight.show.mock.calls.length +
    ui.answer.showText.mock.calls.length +
    agentCalls.filter((c) => c !== 'active_window' && c !== 'focus_info').length +
    historyMessages().length
  )
}

async function runCancelled(): Promise<void> {
  const scope = new CancelScope()
  hooks.scope = scope
  await expect(runQuery('what is this', {}, scope, { speak, onGuide })).rejects.toBeInstanceOf(
    CancelledError
  )
}

describe('cancelling a turn (T17)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    history.clear()
    agentCalls.length = 0
    events.length = 0
    Object.assign(hooks, { route: null, capture: null, model: null, reply: null, scope: null })
    calls.model = 0
    setAgent({
      protocol: 2,
      hasCapability: () => true,
      activeWindow: async () => {
        agentCalls.push('active_window')
        return 'Inbox - Gmail'
      },
      execute: async () => agentCalls.push('execute'),
      request: async (cmd: string) => agentCalls.push(cmd)
    } as unknown as AgentBridge)
    off = [
      bus.on('query.cancelled', () => events.push('cancelled')),
      bus.on('query.done', () => events.push('done')),
      bus.on('query.failed', () => events.push('failed'))
    ]
  })
  afterEach(() => {
    off.forEach((f) => f())
    setAgent(null)
  })

  it('runs normally when nothing cancels (control)', async () => {
    const scope = new CancelScope()
    hooks.scope = scope
    await runQuery('what is this', {}, scope, { speak, onGuide })
    expect(speak).toHaveBeenCalledOnce()
    expect(historyMessages().length).toBeGreaterThan(0)
    expect(events).toEqual(['done'])
  })

  it.each(['route', 'capture', 'model'] as const)('cancelled during %s', async (stage) => {
    hooks[stage] = (s) => s.cancel()
    await runCancelled()
    expect(sideEffects()).toBe(0)
    expect(events).toEqual(['cancelled'])
  })

  it('cancelled while locate targets resolve: nothing is drawn', async () => {
    hooks.reply = {
      mode: 'locate',
      items: [{ label: 'Compose', target: { kind: 'text', text: 'Compose' } }]
    } as ModelResponse
    await runCancelled()
    expect(sideEffects()).toBe(0)
    expect(events).toEqual(['cancelled'])
  })

  it('cancelled inside a follow-up: no further input, nothing drawn', async () => {
    hooks.reply = {
      mode: 'action',
      actions: [{ type: 'hotkey', keys: ['ctrl', 'l'] }],
      follow_up: { query: 'Click the first result', delay_ms: 2000 }
    }
    agentTask.calls = 0
    await runCancelled()
    expect(calls.model).toBe(1)
    expect(agentTask.calls).toBe(1)
    expect(agentCalls.filter((c) => c === 'execute')).toHaveLength(1)
    expect(ui.highlight.show).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
    expect(historyMessages()).toHaveLength(0)
    expect(events).toEqual(['cancelled'])
  })

  it('a failing turn publishes query.failed', async () => {
    hooks.model = () => {
      throw new Error('boom')
    }
    const scope = new CancelScope()
    hooks.scope = scope
    await expect(runQuery('x', {}, scope, { speak, onGuide })).rejects.toThrow('boom')
    expect(events).toEqual(['failed'])
  })
})
