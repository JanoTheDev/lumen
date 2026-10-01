import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { waitForSettle, type SettleProbe } from '../../src/main/ai/observe'
import { setFrameCodec, type GrayImage } from '../../src/main/ai/frames'
import { alreadyTyped } from '../../src/main/query/research'
import type { Observed } from '../../src/main/ai/observe'
import type { QueryContext } from '../../src/main/query/context'
import { CancelledError } from '../../src/main/query/cancel'

// Frames are keys into a table of 10x10 gray images with one flat value.
const flat = (v: number): GrayImage => ({ w: 10, h: 10, data: new Uint8Array(100).fill(v) })

interface Script {
  titles?: string[]
  frames: string[]
}

function probe(script: Script): SettleProbe & { polls: number } {
  let t = 0
  const p = {
    polls: 0,
    title: async () => script.titles?.[Math.min(p.polls - 1, script.titles.length - 1)] ?? 'Page',
    frame: async () => script.frames[Math.min(p.polls - 1, script.frames.length - 1)],
    focus: async () => null,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      t += ms
      p.polls++
    },
    now: () => t
  }
  return p
}

describe('waitForSettle (T19)', () => {
  beforeEach(() => setFrameCodec({ gray: (b64) => flat(Number(b64)), crop: () => null }))
  afterEach(() => setFrameCodec(null))

  it('ends on a window-title change', async () => {
    const p = probe({ titles: ['Page', 'Weather - Chrome'], frames: ['10', '20'] })
    const r = await waitForSettle({ title: 'Page', image: '10' }, undefined, 1500, p)
    expect(r.reason).toBe('title')
    expect(r.ms).toBe(200)
  })

  it('ends when two consecutive frames match after the screen moved', async () => {
    const p = probe({ frames: ['10', '90', '90'] })
    const r = await waitForSettle({ title: 'Page', image: '10' }, undefined, 1500, p)
    expect(r).toEqual({ reason: 'frames', ms: 300 })
  })

  it('a screen that has not reacted yet waits a minimum before counting as settled', async () => {
    const p = probe({ frames: ['10'] })
    const r = await waitForSettle({ title: 'Page', image: '10' }, undefined, 1500, p)
    expect(r.reason).toBe('frames')
    expect(r.ms).toBe(400)
  })

  it('never waits longer than 1.5 s', async () => {
    let v = 0
    const p = probe({ frames: [] })
    p.frame = async () => String((v += 40) % 256)
    const r = await waitForSettle({ title: 'Page', image: '10' }, undefined, 1500, p)
    expect(r).toEqual({ reason: 'timeout', ms: 1500 })
  })

  it('a cancel ends the wait with the abort', async () => {
    const ac = new AbortController()
    ac.abort(new CancelledError())
    await expect(
      waitForSettle({ title: 'Page' }, ac.signal, 1500, probe({ frames: ['1'] }))
    ).rejects.toBeInstanceOf(CancelledError)
  })
})

describe('alreadyTyped (idempotent retry)', () => {
  const now = (focus: Observed['obs']['focus'], lines: string[] = []): Observed => ({
    ctx: {
      ocr: async () => ({
        words: [],
        lines: lines.map((text) => ({ text, rect: { x: 0, y: 0, w: 1, h: 1 }, conf: 90 }))
      })
    } as unknown as QueryContext,
    obs: { at: 0, title: 'Gmail', focus }
  })

  it('trusts the focused field value when UIA exposes it', async () => {
    const field = { role: 'edit', name: 'Subject', editable: true, valueTail: 'Resignation' }
    expect(await alreadyTyped('Resignation', now(field))).toBe(true)
    // UIA is authoritative: an OCR hit elsewhere does not count.
    const other = { ...field, valueTail: 'Something else' }
    expect(await alreadyTyped('Resignation', now(other, ['Resignation']))).toBe(false)
  })

  it('falls back to OCR when the value is not exposed', async () => {
    expect(
      await alreadyTyped('Dear team, I am leaving', now(null, ['Dear team, I am', 'leaving']))
    ).toBe(true)
    expect(await alreadyTyped('Dear team', now(null, ['Inbox']))).toBe(false)
    // Short text is too likely to appear somewhere else on screen.
    expect(await alreadyTyped('Hi', now(null, ['Hi there']))).toBe(false)
  })
})
