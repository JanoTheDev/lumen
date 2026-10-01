import { describe, expect, it } from 'vitest'
import { titleMatcher, waitFor, type WaitProbe } from '../../src/main/agent-mode/wait-for'

function probe(over: Partial<WaitProbe> = {}): WaitProbe {
  return {
    title: async () => 'Inbox - Gmail',
    element: async () => false,
    screenText: async () => '',
    now: () => Date.now(),
    ...over
  }
}

describe('waitFor', () => {
  it('returns at once when the condition already holds', async () => {
    const r = await waitFor(
      { kind: 'window_title', value: 'gmail' },
      5000,
      probe(),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(r.ms).toBeLessThan(50)
  })

  it('polls until an element appears', async () => {
    let n = 0
    const r = await waitFor(
      { kind: 'element', value: 'Compose', role: 'button' },
      5000,
      probe({ element: async () => ++n >= 3 }),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(n).toBe(3)
  })

  it('re-checks on a change hint without waiting for the next poll', async () => {
    let cb: (() => void) | null = null
    let ready = false
    const p = probe({
      title: async () => (ready ? 'New message' : 'Inbox'),
      onChange: (fn) => {
        cb = fn
        return () => (cb = null)
      }
    })
    const t0 = Date.now()
    const run = waitFor(
      { kind: 'window_title', value: 'new message' },
      5000,
      p,
      new AbortController().signal
    )
    setTimeout(() => {
      ready = true
      cb?.()
    }, 30)
    const r = await run
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(cb).toBeNull()
  })

  it('times out with what it saw', async () => {
    const r = await waitFor(
      { kind: 'text', value: 'Sent' },
      50,
      probe(),
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('not on screen yet')
  })

  it('stops on abort', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(new Error('stop')), 20)
    await expect(
      waitFor({ kind: 'element', value: 'x' }, 10_000, probe(), ac.signal)
    ).rejects.toThrow('stop')
  })

  it('treats a broken regex as plain text', () => {
    expect(titleMatcher('C++ (')('Learn C++ ( today')).toBe(true)
    expect(titleMatcher('^inbox')('Inbox - Gmail')).toBe(true)
  })
})
