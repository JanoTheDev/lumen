import { describe, it, expect, vi, beforeAll } from 'vitest'
import { EventEmitter } from 'events'

const ipc = vi.hoisted(() => ({
  emitter: null as EventEmitter | null,
  send: vi.fn(),
  exposed: {} as Record<string, unknown>
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  const emitter = new EventEmitter()
  ipc.emitter = emitter
  return {
    ipcRenderer: {
      on: (ch: string, h: (...a: unknown[]) => void) => emitter.on(ch, h),
      removeListener: (ch: string, h: (...a: unknown[]) => void) => emitter.removeListener(ch, h),
      send: ipc.send,
      invoke: vi.fn()
    },
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        ipc.exposed[key] = value
      }
    }
  }
})

interface Lumen {
  invoke: (c: string, ...a: unknown[]) => Promise<unknown>
  send: (c: string, ...a: unknown[]) => void
  on: (c: string, cb: (...a: unknown[]) => void) => () => void
}
let lumen: Lumen

beforeAll(async () => {
  await import('../src/preload/index')
  lumen = ipc.exposed.lumen as Lumen
})

describe('preload window.lumen', () => {
  it('exposes only window.lumen', () => {
    expect(Object.keys(ipc.exposed)).toEqual(['lumen'])
  })

  it('passes payload without the event and stops after unsubscribe', () => {
    const cb = vi.fn()
    const unsub = lumen.on('assistant:run-query', cb)
    ipc.emitter!.emit('assistant:run-query', { sender: null }, 'open gmail')
    expect(cb).toHaveBeenCalledWith('open gmail')
    unsub()
    ipc.emitter!.emit('assistant:run-query', { sender: null }, 'again')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('repeated subscribe/unsubscribe does not leak listeners', () => {
    for (let i = 0; i < 5; i++) {
      const unsub = lumen.on('wake:model-progress', () => {})
      unsub()
    }
    expect(ipc.emitter!.listenerCount('wake:model-progress')).toBe(0)
  })

  it('send forwards allowed channels', () => {
    lumen.send('assistant:open-link', 'https://example.com')
    expect(ipc.send).toHaveBeenCalledWith('assistant:open-link', 'https://example.com')
  })

  it('rejects channels outside the table', async () => {
    await expect(lumen.invoke('execute-shell', 'calc')).rejects.toThrow(/unknown channel/)
    expect(() => lumen.send('close-hud')).toThrow(/unknown channel/)
    expect(() => lumen.on('status-set', () => {})).toThrow(/unknown channel/)
    expect(() => lumen.on('status:set', () => {})).toThrow(/unknown channel/)
    lumen.send('assistant:cancel')
    expect(ipc.send).toHaveBeenCalledWith('assistant:cancel')
  })
})
