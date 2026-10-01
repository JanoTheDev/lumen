import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadSherpa,
  onSherpaRestart,
  onSpotterHits,
  setSherpaWorkerFactory,
  sherpaFeed,
  sherpaRequest,
  sherpaSupported,
  type SherpaWorker
} from '../../src/main/speech/sherpa'
import type { EngineEvent, EngineRequest } from '../../src/main/speech/sherpa-engine'

vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))

class FakeWorker extends EventEmitter implements SherpaWorker {
  readonly sent: Array<{ msg: EngineRequest; transfer?: ArrayBuffer[] }> = []
  terminated = false
  postMessage(msg: EngineRequest, transfer?: ArrayBuffer[]): void {
    this.sent.push({ msg, transfer })
  }
  terminate(): void {
    this.terminated = true
  }
  reply(e: EngineEvent): void {
    this.emit('message', e)
  }
  lastId(): number {
    return (this.sent[this.sent.length - 1].msg as { id: number }).id
  }
}

let workers: FakeWorker[]
const current = (): FakeWorker => workers[workers.length - 1]

beforeEach(() => {
  workers = []
  setSherpaWorkerFactory(() => {
    const w = new FakeWorker()
    workers.push(w)
    return w
  })
})

describe('sherpa worker host', () => {
  it('starts one worker lazily and round-trips requests by id', async () => {
    expect(workers).toHaveLength(0)
    const a = sherpaRequest<string>({ t: 'stt-warm', model: { dir: 'd', threads: 1 } })
    const b = sherpaRequest<string>({ t: 'recent' })
    expect(workers).toHaveLength(1)
    const [ida, idb] = current().sent.map((s) => (s.msg as { id: number }).id)
    current().reply({ t: 'reply', id: idb, ok: false, error: 'nope' })
    current().reply({ t: 'reply', id: ida, ok: true, value: 'loaded' })
    await expect(a).resolves.toBe('loaded')
    await expect(b).rejects.toThrow('nope')
  })

  it('reports an engine that does not load and stops using the worker', async () => {
    const pending = sherpaRequest({ t: 'recent' })
    const supported = sherpaSupported()
    current().reply({ t: 'ready', supported: false, error: 'dll missing' })
    await expect(supported).resolves.toBe(false)
    await expect(pending).rejects.toThrow('not available')
    expect(current().terminated).toBe(true)
    expect(loadSherpa()).toBe(false)
    await expect(sherpaRequest({ t: 'recent' })).rejects.toThrow('not available')
    expect(workers).toHaveLength(1)
  })

  it('fails pending requests on a crash and restarts on the next request', async () => {
    const restarted = vi.fn()
    const off = onSherpaRestart(restarted)
    const pending = sherpaRequest({ t: 'recent' })
    current().reply({ t: 'ready', supported: true })
    current().emit('exit', 3)
    await expect(pending).rejects.toThrow('speech engine stopped')
    expect(restarted).toHaveBeenCalledTimes(1)
    expect(loadSherpa()).toBe(true)
    expect(workers).toHaveLength(2)
    off()
  })

  it('gives up after three crashes in a minute', () => {
    for (let i = 0; i < 3; i++) {
      loadSherpa()
      current().emit('error', new Error('boom'))
    }
    expect(loadSherpa()).toBe(false)
    expect(workers).toHaveLength(3)
  })

  it('sends mic blocks and forwards spotted phrases', () => {
    const hits = vi.fn()
    const off = onSpotterHits(hits)
    sherpaFeed(new ArrayBuffer(4)) // no worker yet: dropped
    loadSherpa()
    const pcm = new ArrayBuffer(8)
    sherpaFeed(pcm)
    expect(current().sent[0]).toEqual({ msg: { t: 'feed', pcm }, transfer: undefined })
    current().reply({ t: 'hits', hits: [{ kind: 'wake', phrase: 'hey lumen' }] })
    expect(hits).toHaveBeenCalledWith([{ kind: 'wake', phrase: 'hey lumen' }])
    off()
  })

  it('ignores messages from a replaced worker', async () => {
    const pending = sherpaRequest({ t: 'recent' })
    const old = current()
    old.emit('exit', 1)
    await expect(pending).rejects.toThrow()
    const next = sherpaRequest<string>({ t: 'recent' })
    old.reply({ t: 'reply', id: current().lastId(), ok: true, value: 'stale' })
    current().reply({ t: 'reply', id: current().lastId(), ok: true, value: 'fresh' })
    await expect(next).resolves.toBe('fresh')
  })
})
