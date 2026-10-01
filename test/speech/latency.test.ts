import { describe, expect, it } from 'vitest'
import { VoiceLatency } from '../../src/main/speech/latency'

function setup(): { l: VoiceLatency; logs: string[]; tick: (ms: number) => void } {
  let now = 1000
  const logs: string[] = []
  const l = new VoiceLatency(
    () => now,
    (mark, ms) => logs.push(`${mark} ${ms}`)
  )
  return { l, logs, tick: (ms) => (now += ms) }
}

describe('VoiceLatency', () => {
  it('marks each step once, from the end of speech', () => {
    const { l, logs, tick } = setup()
    l.speechEnded()
    tick(120)
    l.mark('stt-final')
    l.turnStarted('t1')
    tick(500)
    l.mark('first-token', 't1')
    l.mark('first-token', 't1')
    tick(200)
    l.mark('tts-first-audio', 't1')
    expect(logs).toEqual(['hotkey-up 0', 'stt-final 120', 'first-token 620', 'tts-first-audio 820'])
  })

  it('ignores marks of another turn and marks without speech', () => {
    const { l, logs, tick } = setup()
    l.mark('stt-final')
    l.speechEnded()
    l.turnStarted('t1')
    tick(50)
    l.mark('first-token', 't0')
    expect(logs).toEqual(['hotkey-up 0'])
  })

  it('reports p50 and p95 over turns', () => {
    const { l, tick } = setup()
    for (const ms of [100, 200, 300, 400]) {
      l.speechEnded()
      tick(ms)
      l.mark('stt-final')
    }
    const r = l.report()
    expect(r['stt-final']).toEqual({ n: 4, p50: 200, p95: 400 })
    expect(r['first-token']).toBeNull()
  })
})
