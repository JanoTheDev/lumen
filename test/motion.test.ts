import { describe, it, expect } from 'vitest'
import {
  SPRINGS,
  animateSpring,
  atRest,
  stepSpring,
  type Clock,
  type SpringState
} from '../src/renderer/src/ui/motion'

/** A manual clock: each frame advances time by 1/120 s. */
function fakeClock(): Clock & { run: (maxFrames?: number) => number } {
  let t = 0
  let queue: Array<() => void> = []
  return {
    now: () => t,
    frame: (cb) => {
      queue.push(cb)
      return queue.length
    },
    cancel: () => {
      queue = []
    },
    run(maxFrames = 2000) {
      let frames = 0
      while (queue.length && frames < maxFrames) {
        const q = queue
        queue = []
        t += 1000 / 120
        q.forEach((cb) => cb())
        frames++
      }
      return frames
    }
  }
}

function settle(
  preset: keyof typeof SPRINGS,
  from: number,
  to: number
): { ms: number; peak: number } {
  let s: SpringState = { x: [from], v: [0] }
  let peak = from
  let ms = 0
  while (!atRest(s, [to]) && ms < 5000) {
    s = stepSpring(s, [to], SPRINGS[preset], 1 / 120)
    peak = Math.max(peak, s.x[0])
    ms += 1000 / 120
  }
  return { ms, peak }
}

describe('springs', () => {
  for (const name of Object.keys(SPRINGS) as Array<keyof typeof SPRINGS>) {
    it(`${name} settles quickly with no visible overshoot`, () => {
      const { ms, peak } = settle(name, 0, 100)
      expect(ms).toBeLessThan(1200)
      // Lightly underdamped is fine; a bounce past 1% of the distance is not.
      expect(peak).toBeLessThan(101)
    })
  }

  it('animateSpring reaches the target and resolves', async () => {
    const clock = fakeClock()
    const seen: number[] = []
    const h = animateSpring({
      from: [0],
      to: [50],
      preset: 'snappy',
      onFrame: ([x]) => seen.push(x),
      reduced: false,
      clock
    })
    clock.run()
    await h.done
    expect(seen[seen.length - 1]).toBe(50)
    expect(seen.length).toBeGreaterThan(5)
  })

  it('retarget keeps velocity instead of restarting from rest', () => {
    const clock = fakeClock()
    const seen: number[] = []
    const h = animateSpring({
      from: [0],
      to: [100],
      preset: 'glide',
      onFrame: ([x]) => seen.push(x),
      reduced: false,
      clock
    })
    clock.run(10)
    const before = seen.slice(-2)
    const v = before[1] - before[0]
    expect(v).toBeGreaterThan(0)
    h.retarget([200])
    clock.run(1)
    const after = seen.slice(-2)
    // Next step continues forward at least as fast; no jump back or stall.
    expect(after[1] - after[0]).toBeGreaterThanOrEqual(v * 0.9)
    clock.run()
    expect(seen[seen.length - 1]).toBe(200)
  })

  it('reduced motion jumps straight to the end', async () => {
    const clock = fakeClock()
    const seen: number[][] = []
    const h = animateSpring({
      from: [0, 0],
      to: [10, 20],
      onFrame: (v) => seen.push(v),
      reduced: true,
      clock
    })
    await h.done
    expect(seen).toEqual([[10, 20]])
    expect(clock.run()).toBe(0)
  })
})
