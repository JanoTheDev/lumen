import { describe, expect, it } from 'vitest'
import { RmsGate } from '../../src/renderer/src/voice/vad/rms'

const feed = (g: RmsGate, level: number, n: number): boolean[] =>
  Array.from({ length: n }, () => g.update(level))

describe('RmsGate', () => {
  it('behaves like the fixed threshold in a quiet room', () => {
    const g = new RmsGate({ threshold: 0.04 })
    feed(g, 0.002, 50)
    expect(g.update(0.03)).toBe(false)
    expect(g.update(0.06)).toBe(true)
  })

  it('learns steady fan noise so it stops counting as speech', () => {
    const g = new RmsGate({ threshold: 0.04 })
    const fan = feed(g, 0.06, 600)
    expect(fan[0]).toBe(true)
    expect(fan.at(-1)).toBe(false)
  })

  it('still hears speech clearly above the fan', () => {
    const g = new RmsGate({ threshold: 0.04 })
    feed(g, 0.06, 600)
    expect(g.update(0.4)).toBe(true)
  })

  it('does not learn speech with pauses as noise', () => {
    const g = new RmsGate({ threshold: 0.04 })
    feed(g, 0.003, 20)
    let heard = 0
    for (let i = 0; i < 40; i++) {
      // ~1s of speech then a short pause, repeated
      heard += feed(g, 0.15, 12).filter(Boolean).length
      feed(g, 0.003, 4)
    }
    expect(heard).toBe(40 * 12)
  })
})
