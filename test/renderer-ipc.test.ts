import { describe, expect, it } from 'vitest'
import { subscribeIpc } from '../src/renderer/src/lib/ipc'
import type { LumenApi } from '../src/shared/channels'

function fakeLumen(): {
  api: Pick<LumenApi, 'on'>
  emit: (ch: string, ...a: unknown[]) => void
  count: () => number
} {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>()
  return {
    api: {
      on: ((ch: string, cb: (...a: unknown[]) => void) => {
        const set = listeners.get(ch) ?? new Set()
        set.add(cb)
        listeners.set(ch, set)
        return () => set.delete(cb)
      }) as LumenApi['on']
    },
    emit: (ch, ...a) => listeners.get(ch)?.forEach((cb) => cb(...a)),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

describe('subscribeIpc', () => {
  it('leaves one listener after a StrictMode mount, unmount, mount', () => {
    const f = fakeLumen()
    const calls: string[] = []
    const handler = (route: string): void => {
      calls.push(route)
    }
    const effect = (): (() => void) => subscribeIpc(f.api, 'panel:route', () => handler)
    const cleanup = effect()
    cleanup()
    effect()
    expect(f.count()).toBe(1)
    f.emit('panel:route', 'home')
    expect(calls).toEqual(['home'])
  })

  it('calls the latest handler without resubscribing', () => {
    const f = fakeLumen()
    let current = (r: string): string => `old ${r}`
    const seen: string[] = []
    subscribeIpc(f.api, 'panel:route', () => (r: string) => {
      seen.push(current(r))
    })
    current = (r) => `new ${r}`
    f.emit('panel:route', 'x')
    expect(seen).toEqual(['new x'])
    expect(f.count()).toBe(1)
  })

  it('is a no-op without a bridge', () => {
    const off = subscribeIpc(undefined, 'panel:route', () => () => {})
    expect(() => off()).not.toThrow()
  })
})
