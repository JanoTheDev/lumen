import { describe, it, expect, vi } from 'vitest'
import type { AssistantPhase } from '../src/shared/events'
import {
  Countdown,
  filesRefreshKey,
  latestPerFrame,
  rowGlide,
  sizeReporter,
  type CountdownAnimation,
  type CountdownTarget,
  type FrameSchedule
} from '../src/renderer/src/assistant/bar-timing'
import { onVoiceLevel, publishVoiceLevel, voiceLevel } from '../src/renderer/src/voice/useVoice'

function frames(): { schedule: FrameSchedule; flush: () => void; pending: () => number } {
  let queue: Array<() => void> = []
  return {
    schedule: (fn) => {
      queue.push(fn)
      return () => {
        queue = queue.filter((f) => f !== fn)
      }
    },
    flush: () => {
      const q = queue
      queue = []
      for (const fn of q) fn()
    },
    pending: () => queue.length
  }
}

describe('bar state per frame', () => {
  it('applies only the newest of many pushes, once per frame', () => {
    const f = frames()
    const apply = vi.fn()
    const batch = latestPerFrame<string>(apply, f.schedule)
    for (const v of ['a', 'ab', 'abc']) batch.push(v)
    expect(apply).not.toHaveBeenCalled()
    expect(f.pending()).toBe(1)
    f.flush()
    expect(apply.mock.calls).toEqual([['abc']])
    batch.push('abcd')
    f.flush()
    expect(apply).toHaveBeenLastCalledWith('abcd')
    batch.push('x')
    batch.cancel()
    f.flush()
    expect(apply).toHaveBeenCalledTimes(2)
  })
})

describe('card size reports', () => {
  it('sends a size once per frame and skips an unchanged one', () => {
    const f = frames()
    const report = vi.fn()
    const sizes = sizeReporter(report, f.schedule)
    sizes.size(600, 80)
    sizes.size(600, 96)
    f.flush()
    sizes.size(600, 96)
    f.flush()
    sizes.size(280, 96)
    f.flush()
    expect(report.mock.calls).toEqual([[{ w: 600, h: 96 }], [{ w: 280, h: 96 }]])
  })
})

describe('shared files refresh', () => {
  it('reads the list once per busy stretch, again when the turn ends or the bar hides', () => {
    const phases: AssistantPhase[] = ['listening', 'transcribing', 'thinking', 'acting', 'confirm']
    const keys = new Set(phases.map((p) => filesRefreshKey(true, p)))
    expect(keys.size).toBe(1)
    expect(filesRefreshKey(true, 'idle')).not.toBe(filesRefreshKey(true, 'thinking'))
    expect(filesRefreshKey(false, 'idle')).not.toBe(filesRefreshKey(true, 'idle'))
    let reads = 0
    let last = ''
    for (const [visible, phase] of [
      [true, 'listening'],
      [true, 'transcribing'],
      [true, 'thinking'],
      [true, 'acting'],
      [true, 'thinking'],
      [true, 'idle'],
      [false, 'idle']
    ] as Array<[boolean, AssistantPhase]>) {
      const k = filesRefreshKey(visible, phase)
      if (k !== last) reads++
      last = k
    }
    expect(reads).toBe(3)
  })
})

class FakeAnim implements CountdownAnimation {
  currentTime: number | null = 0
  onfinish: CountdownAnimation['onfinish'] = null
  playing = false
  cancelled = false
  constructor(readonly duration: number) {}
  play(): void {
    this.playing = true
  }
  pause(): void {
    this.playing = false
  }
  cancel(): void {
    this.cancelled = true
    this.playing = false
  }
  advance(ms: number): void {
    if (!this.playing) return
    this.currentTime = Math.min(this.duration, (this.currentTime ?? 0) + ms)
    if (this.currentTime >= this.duration) {
      this.playing = false
      this.onfinish?.call(this as never, {} as never)
    }
  }
}

function line(): CountdownTarget & { anims: FakeAnim[] } {
  const anims: FakeAnim[] = []
  return {
    anims,
    animate: (_k, opts) => {
      const a = new FakeAnim(Number(opts.duration))
      anims.push(a)
      return a
    }
  }
}

describe('auto-close countdown', () => {
  it('runs one animation, pauses on hover and closes at the end', () => {
    const done = vi.fn()
    const c = new Countdown(done)
    const el = line()
    c.update(el, true, 1000)
    c.update(el, true, 1000)
    expect(el.anims).toHaveLength(1)
    const a = el.anims[0]
    a.advance(400)
    c.update(el, false, 1000)
    a.advance(1000)
    expect(a.currentTime).toBe(400)
    c.update(el, true, 1000)
    a.advance(600)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('starts over on reset and carries the time to a new line element', () => {
    const done = vi.fn()
    const c = new Countdown(done)
    const el = line()
    c.update(el, true, 1000)
    el.anims[0].advance(300)
    c.reset()
    expect(el.anims[0].cancelled).toBe(true)
    c.update(el, true, 1000)
    expect(el.anims[1].currentTime).toBe(0)
    el.anims[1].advance(500)
    // Pinned: the line goes away, then comes back on unpin.
    c.update(null, false, 1000)
    const next = line()
    c.update(next, true, 1000)
    expect(next.anims[0].currentTime).toBe(500)
    next.anims[0].advance(500)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a time, and a stale animation never closes', () => {
    const done = vi.fn()
    const c = new Countdown(done)
    const el = line()
    c.update(el, true, 0)
    expect(el.anims).toHaveLength(0)
    c.update(el, true, 1000)
    const old = el.anims[0]
    c.reset()
    old.playing = true
    old.advance(1000)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('row glide', () => {
  it('glides only rows that moved, hiding their growth', () => {
    expect(rowGlide(undefined, { d: 100, h: 20 })).toBeNull()
    expect(rowGlide({ d: 100, h: 20 }, { d: 100.2, h: 40 })).toBeNull()
    expect(rowGlide({ d: 100, h: 20 }, { d: 130, h: 50 })).toEqual({ from: 30, grew: 30 })
    expect(rowGlide({ d: 100, h: 20 }, { d: 120, h: 20 }, { y: 10, grew: 5 })).toEqual({
      from: 30,
      grew: 5
    })
  })
})

describe('voice level store', () => {
  it('keeps the scaled level and tells listeners', () => {
    const seen: number[] = []
    const off = onVoiceLevel((l) => seen.push(l))
    publishVoiceLevel(0.05)
    expect(voiceLevel()).toBeCloseTo(0.4)
    publishVoiceLevel(1)
    expect(voiceLevel()).toBe(1)
    publishVoiceLevel(-1)
    expect(voiceLevel()).toBe(0)
    off()
    publishVoiceLevel(0.05)
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBeCloseTo(0.4)
  })
})
