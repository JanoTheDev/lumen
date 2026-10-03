import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  POLL_MS,
  elementPollMs,
  titleMatcher,
  waitFor,
  type WaitProbe
} from '../../src/main/agent-mode/wait-for'

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

  describe('element polling', () => {
    afterEach(() => vi.useRealTimers())

    async function tenSecondMiss(): Promise<number> {
      vi.useFakeTimers()
      let snapshots = 0
      const run = waitFor(
        { kind: 'element', value: 'Compose' },
        10_000,
        probe({
          element: async () => {
            snapshots++
            return false
          }
        }),
        new AbortController().signal
      )
      await vi.advanceTimersByTimeAsync(10_000)
      const r = await run
      expect(r).toMatchObject({ ok: false, ms: 10_000, detail: 'no "Compose" yet' })
      return snapshots
    }

    it('backs off after the first second', () => {
      expect(elementPollMs(0)).toBe(POLL_MS)
      expect(elementPollMs(999)).toBe(POLL_MS)
      expect(elementPollMs(1000)).toBe(500)
      expect(elementPollMs(3000)).toBe(1000)
      expect(elementPollMs(14_000)).toBe(1000)
    })

    it('takes well under half the snapshots of a 4 Hz poll in a 10 s wait', async () => {
      const n = await tenSecondMiss()
      expect(n).toBe(16)
      expect(n).toBeLessThan(10_000 / POLL_MS / 2)
    })

    it('still ends at once on a change hint late in the wait', async () => {
      vi.useFakeTimers()
      let cb: (() => void) | null = null
      let kind: string | undefined
      let ready = false
      let snapshots = 0
      const run = waitFor(
        { kind: 'element', value: 'Send', role: 'button' },
        10_000,
        probe({
          element: async () => {
            snapshots++
            return ready
          },
          onChange: (fn, k) => {
            cb = fn
            kind = k
            return () => (cb = null)
          }
        }),
        new AbortController().signal
      )
      await vi.advanceTimersByTimeAsync(6_100)
      const before = snapshots
      ready = true
      cb?.()
      await vi.advanceTimersByTimeAsync(0)
      const r = await run
      expect(kind).toBe('element')
      expect(r.ok).toBe(true)
      expect(r.ms).toBe(6_100)
      expect(snapshots).toBe(before + 1)
      expect(cb).toBeNull()
    })

    it('keeps the 4 Hz poll for window titles', async () => {
      vi.useFakeTimers()
      let reads = 0
      const run = waitFor(
        { kind: 'window_title', value: 'never' },
        2_000,
        probe({
          title: async () => {
            reads++
            return 'Inbox'
          }
        }),
        new AbortController().signal
      )
      await vi.advanceTimersByTimeAsync(2_000)
      expect((await run).ok).toBe(false)
      expect(reads).toBe(9)
    })
  })
})
