import { describe, expect, it, vi } from 'vitest'
import type { AgentBridge } from '../../src/main/agent/bridge'
import { atState } from '../../src/main/a11y/at-state'
import { installSystemEvents, refreshAtState } from '../../src/main/a11y/system-events'
import { textScaleFactor } from '../../src/main/a11y/text-scale'

function fakeAgent(reply: unknown = null): {
  agent: AgentBridge
  emit: (ev: string, d: unknown) => void
} {
  const handlers = new Map<string, (data: unknown) => void>()
  const agent = {
    running: true,
    onEvent: (ev: string, fn: (data: unknown) => void) => handlers.set(ev, fn),
    request: vi.fn(() => Promise.resolve(reply))
  }
  return {
    agent: agent as unknown as AgentBridge,
    emit: (ev: string, d: unknown) => handlers.get(ev)?.(d)
  }
}

describe('system events', () => {
  it('applies system-settings and a11y-state, syncing only on change', () => {
    const { agent, emit } = fakeAgent()
    const onAt = vi.fn()
    installSystemEvents(agent, onAt)
    emit('system-settings', { textScale: 175, highContrast: false, reduceMotion: true })
    expect(textScaleFactor()).toBe(175)
    emit('a11y-state', { screenReader: 'nvda', voiceControl: [] })
    emit('a11y-state', { screenReader: 'nvda', voiceControl: [] })
    expect(atState().screenReader).toBe('nvda')
    expect(onAt).toHaveBeenCalledTimes(1)
    emit('system-settings', {})
    expect(textScaleFactor()).toBe(100)
  })

  it('reads the state once on demand and survives a failing agent', async () => {
    const { agent } = fakeAgent({ screenReader: null, voiceControl: ['dragon'] })
    expect(await refreshAtState(agent)).toBe(true)
    expect(atState().voiceControl).toEqual(['dragon'])
    const broken = {
      running: true,
      request: () => Promise.reject(new Error('down'))
    } as unknown as AgentBridge
    expect(await refreshAtState(broken)).toBe(false)
    expect(await refreshAtState(null)).toBe(false)
  })
})
