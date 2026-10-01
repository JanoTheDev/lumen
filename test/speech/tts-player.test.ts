import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FADE_S,
  SPEAKING_HOLD_MS,
  TtsPlayer,
  nextStart,
  type PlayerContext
} from '../../src/renderer/src/voice/player'

interface FakeSource {
  buffer: { duration: number } | null
  startAt: number | null
  stopAt: number | null
  onended: (() => void) | null
  connect: () => void
  start: (t: number) => void
  stop: (t: number) => void
}

function fakeContext(): PlayerContext & {
  now: number
  sources: FakeSource[]
  ramps: Array<[number, number]>
} {
  const sources: FakeSource[] = []
  const ramps: Array<[number, number]> = []
  const ctx = {
    now: 0,
    sources,
    ramps,
    get currentTime() {
      return ctx.now
    },
    destination: {} as AudioNode,
    state: 'running',
    resume: () => Promise.resolve(),
    // The fake "encoding": the first byte is the duration in tenths of a second.
    decodeAudioData: (data: ArrayBuffer) =>
      Promise.resolve({ duration: new Uint8Array(data)[0] / 10 } as AudioBuffer),
    createGain: () =>
      ({
        connect: () => {},
        gain: {
          value: 1,
          cancelScheduledValues: () => {},
          setValueAtTime: () => {},
          linearRampToValueAtTime: (v: number, t: number) => ramps.push([v, t])
        }
      }) as unknown as GainNode,
    createBufferSource: () => {
      const s: FakeSource = {
        buffer: null,
        startAt: null,
        stopAt: null,
        onended: null,
        connect: () => {},
        start: (t) => (s.startAt = t),
        stop: (t) => (s.stopAt = t)
      }
      sources.push(s)
      return s as unknown as AudioBufferSourceNode
    }
  }
  return ctx
}

const chunk = (tenths: number): ArrayBuffer => new Uint8Array([tenths]).buffer

describe('nextStart', () => {
  it('starts right after the queue, never in the past', () => {
    expect(nextStart(1, 0, 0.02)).toBeCloseTo(1.02)
    expect(nextStart(1, 3, 0.02)).toBe(3)
  })
})

describe('TtsPlayer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('schedules chunks back to back without gaps', async () => {
    const ctx = fakeContext()
    const p = new TtsPlayer(() => ctx)
    await p.enqueue(chunk(10))
    await p.enqueue(chunk(5))
    const [a, b] = ctx.sources
    expect(a.startAt).toBeCloseTo(0.02)
    expect(b.startAt).toBeCloseTo(a.startAt! + 1)
  })

  it('stops with a 30 ms fade and drops chunks still decoding', async () => {
    const ctx = fakeContext()
    const p = new TtsPlayer(() => ctx)
    await p.enqueue(chunk(10))
    ctx.now = 0.5
    const late = p.enqueue(chunk(10))
    p.stop()
    await late
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0].stopAt).toBeCloseTo(0.5 + FADE_S)
    expect(ctx.ramps.at(-1)).toEqual([0, 0.5 + FADE_S])
    expect(p.speaking).toBe(false)
    // Playback after a stop starts fresh, not after the dropped queue.
    await p.enqueue(chunk(10))
    expect(ctx.sources[1].startAt).toBeCloseTo(0.52)
  })

  it('reports speaking until the queue has been quiet for a moment', async () => {
    const ctx = fakeContext()
    const p = new TtsPlayer(() => ctx)
    const states: boolean[] = []
    p.onSpeakingChange((on) => states.push(on))
    await p.enqueue(chunk(10))
    expect(states).toEqual([true])
    ctx.sources[0].onended?.()
    // The next sentence arrives within the hold: still one speaking stretch.
    await vi.advanceTimersByTimeAsync(SPEAKING_HOLD_MS - 100)
    await p.enqueue(chunk(10))
    ctx.sources[1].onended?.()
    await vi.advanceTimersByTimeAsync(SPEAKING_HOLD_MS + 1)
    expect(states).toEqual([true, false])
  })

  it('reports how each chunk ended: played, stopped or failed', async () => {
    const ctx = fakeContext()
    const p = new TtsPlayer(() => ctx)
    const ends: string[] = []
    await p.enqueue(chunk(10), (e) => ends.push(`a:${e}`))
    await p.enqueue(chunk(10), (e) => ends.push(`b:${e}`))
    ctx.sources[0].onended?.()
    expect(ends).toEqual(['a:ended'])
    const late = p.enqueue(chunk(10), (e) => ends.push(`c:${e}`))
    p.stop()
    await late
    expect(ends).toEqual(['a:ended', 'b:stopped', 'c:stopped'])
    ctx.decodeAudioData = () => Promise.reject(new Error('bad audio'))
    await p.enqueue(chunk(10), (e) => ends.push(`d:${e}`))
    expect(ends.at(-1)).toBe('d:failed')
  })
})
