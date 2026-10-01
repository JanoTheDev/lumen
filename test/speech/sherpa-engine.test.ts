// The engine that runs in the speech worker. The model-backed cases run only where the wake
// model has been downloaded (~/.ai-overlay/wake-model); the input is generated noise.
import { describe, expect, it, vi } from 'vitest'
import { createEngine, type EngineEvent } from '../../src/main/speech/sherpa-engine'
import { kwsModelDir, kwsModelInstalled } from '../../src/main/speech/wake/kws-model'
import { loadAddon } from './sherpa-inthread'

vi.mock('../../src/main/windows/registry', () => ({ broadcast: () => {} }))

interface Harness {
  events: EngineEvent[]
  engine: ReturnType<typeof createEngine>
  reply(id: number): Promise<EngineEvent>
}

function harness(lib: ReturnType<typeof loadAddon>): Harness {
  const events: EngineEvent[] = []
  const engine = createEngine(lib, (e) => events.push(e))
  const reply = async (id: number): Promise<EngineEvent> => {
    await vi.waitFor(
      () => expect(events.find((e) => e.t === 'reply' && e.id === id)).toBeTruthy(),
      {
        timeout: 30_000
      }
    )
    return events.find((e) => e.t === 'reply' && e.id === id)!
  }
  return { events, engine, reply }
}

function noiseBlock(n = 1600, amp = 3000): ArrayBuffer {
  const pcm = new Int16Array(n)
  for (let i = 0; i < n; i++) pcm[i] = Math.round((Math.random() * 2 - 1) * amp)
  return pcm.buffer
}

describe('sherpa engine without the addon', () => {
  it('answers every request with an error and ignores audio', async () => {
    const { engine, events, reply } = harness(null)
    engine.handle({ t: 'spotter', id: 1, dir: 'x', phrases: { wake: 'hey lumen', cancel: [] } })
    engine.handle({
      t: 'stt',
      id: 2,
      model: { dir: 'x', threads: 1 },
      samples: new Float32Array(4),
      sampleRate: 16000
    })
    engine.handle({ t: 'feed', pcm: noiseBlock() })
    expect(await reply(1)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not available')
    })
    expect(await reply(2)).toMatchObject({ ok: false })
    expect(events.some((e) => e.t === 'hits')).toBe(false)
  })

  it('has no recent audio before a spotter exists', async () => {
    const { engine, reply } = harness(null)
    engine.handle({ t: 'recent', id: 7 })
    expect(await reply(7)).toEqual({ t: 'reply', id: 7, ok: true, value: null })
  })
})

const addon = loadAddon()
describe.skipIf(!addon || !kwsModelInstalled())('sherpa engine with the wake model', () => {
  it('builds a spotter, feeds it and keeps the last audio', { timeout: 60_000 }, async () => {
    const { engine, events, reply } = harness(addon)
    engine.handle({
      t: 'spotter',
      id: 1,
      dir: kwsModelDir(),
      phrases: { wake: 'hey lumen', cancel: ['stop', 'привет'] }
    })
    expect(await reply(1)).toMatchObject({ ok: true, value: { unusable: ['привет'] } })
    for (let i = 0; i < 30; i++) engine.handle({ t: 'feed', pcm: noiseBlock() })
    engine.handle({ t: 'recent', id: 2 })
    const recent = await reply(2)
    expect(recent.t === 'reply' && recent.ok && (recent.value as Float32Array).length).toBe(
      25 * 1600
    )
    expect(events.some((e) => e.t === 'hits')).toBe(false)

    engine.handle({ t: 'spotter-off' })
    engine.handle({ t: 'recent', id: 3 })
    expect(await reply(3)).toMatchObject({ ok: true, value: null })
  })
})
