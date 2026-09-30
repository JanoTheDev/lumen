import { describe, it, expect, vi, beforeAll } from 'vitest'
import { EventEmitter } from 'events'

const ipc = vi.hoisted(() => ({ emitter: null as EventEmitter | null, send: vi.fn(), exposed: {} as Record<string, unknown> }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  const emitter = new EventEmitter()
  ipc.emitter = emitter
  return {
    ipcRenderer: {
      on: (ch: string, h: (...a: unknown[]) => void) => emitter.on(ch, h),
      removeListener: (ch: string, h: (...a: unknown[]) => void) => emitter.removeListener(ch, h),
      send: ipc.send,
      invoke: vi.fn(),
    },
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => { ipc.exposed[key] = value },
    },
  }
})

type Api = Record<string, (...a: unknown[]) => unknown>
let api: Api

beforeAll(async () => {
  await import('../src/preload/index')
  api = ipc.exposed.api as Api
})

describe('preload api subscriptions', () => {
  it('every on* returns an unsubscribe function', () => {
    const onKeys = Object.keys(api).filter((k) => /^on[A-Z]/.test(k))
    expect(onKeys.length).toBeGreaterThan(10)
    for (const k of onKeys) {
      const unsub = api[k](() => {})
      expect(typeof unsub, k).toBe('function')
      ;(unsub as () => void)()
    }
    for (const ch of ipc.emitter!.eventNames()) {
      expect(ipc.emitter!.listenerCount(ch), String(ch)).toBe(0)
    }
  })

  it('passes payload without the event and stops after unsubscribe', () => {
    const cb = vi.fn()
    const unsub = api.onRunQuery(cb) as () => void
    ipc.emitter!.emit('run-query', { sender: null }, 'open gmail')
    expect(cb).toHaveBeenCalledWith('open gmail')
    unsub()
    ipc.emitter!.emit('run-query', { sender: null }, 'again')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('repeated subscribe/unsubscribe does not leak listeners', () => {
    for (let i = 0; i < 5; i++) {
      const unsub = api.onWakeModelProgress(() => {}) as () => void
      unsub()
    }
    expect(ipc.emitter!.listenerCount('wake-model-progress')).toBe(0)
  })

  it('openLink sends on the assistant channel', () => {
    api.openLink('https://example.com')
    expect(ipc.send).toHaveBeenCalledWith('assistant:open-link', 'https://example.com')
  })
})
