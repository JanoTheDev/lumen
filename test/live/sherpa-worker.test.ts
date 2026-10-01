/**
 * Run: npm run test:live (needs the wake and offline speech models in ~/.ai-overlay).
 * Bundles the real speech worker entry, runs it on a worker thread and checks that building
 * the spotter, feeding it and transcribing never stall this (main) thread. Input is generated
 * noise plus the STT fixture wav; nothing is recorded or played.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { performance } from 'perf_hooks'
import { Worker } from 'worker_threads'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  setSherpaWorkerFactory,
  sherpaFeed,
  sherpaRequest,
  type SherpaWorker
} from '../../src/main/speech/sherpa'
import type { SpotterBuilt } from '../../src/main/speech/sherpa-engine'
import { localModelInstalled } from '../../src/main/speech/stt/local-model'
import { transcribeLocal } from '../../src/main/speech/stt/local'
import { parseWav } from '../../src/main/speech/stt/wav'
import { kwsModelDir, kwsModelInstalled } from '../../src/main/speech/wake/kws-model'

vi.mock('../../src/main/windows/registry', () => ({ broadcast: () => {} }))

// Inside the repo so the bundle resolves sherpa-onnx-node from node_modules.
const cache = resolve(__dirname, '../../node_modules/.cache')
mkdirSync(cache, { recursive: true })
const out = mkdtempSync(join(cache, 'lumen-sherpa-'))

/** Largest gap a 4 ms interval sees while `fn` runs. */
async function stallDuring<T>(
  fn: () => Promise<T>
): Promise<{ value: T; ms: number; stall: number }> {
  let last = performance.now()
  let worst = 0
  const t = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 4)
    last = now
  }, 4)
  const t0 = performance.now()
  const value = await fn()
  const ms = performance.now() - t0
  clearInterval(t)
  return { value, ms, stall: worst }
}

describe.skipIf(!kwsModelInstalled() || !localModelInstalled())('sherpa speech worker', () => {
  beforeAll(async () => {
    await build({
      logLevel: 'silent',
      build: {
        ssr: resolve(__dirname, '../../src/main/speech/sherpa-worker.ts'),
        outDir: out,
        rollupOptions: {
          external: ['sherpa-onnx-node'],
          output: { format: 'cjs', entryFileNames: 'w.cjs' }
        }
      }
    })
    const file = join(out, 'w.cjs')
    expect(readFileSync(file, 'utf8')).toContain('sherpa-onnx-node')
    setSherpaWorkerFactory(() => {
      const w = new Worker(file, { workerData: { sherpa: true } })
      w.unref()
      return w as unknown as SherpaWorker
    })
  }, 60_000)

  afterAll(() => rmSync(out, { recursive: true, force: true }))

  it('keeps the main thread free', { timeout: 120_000 }, async () => {
    const spot = await stallDuring(() =>
      sherpaRequest<SpotterBuilt>({
        t: 'spotter',
        dir: kwsModelDir(),
        phrases: { wake: 'hey lumen', cancel: ['stop', 'cancel', 'never mind'] }
      })
    )
    expect(spot.value.unusable).toEqual([])

    const feed = await stallDuring(async () => {
      for (let i = 0; i < 50; i++) {
        const pcm = new Int16Array(1600)
        for (let j = 0; j < pcm.length; j++) pcm[j] = Math.round((Math.random() * 2 - 1) * 3000)
        sherpaFeed(pcm.buffer)
      }
      return sherpaRequest<Float32Array>({ t: 'recent' })
    })
    expect(feed.value.length).toBe(25 * 1600)

    const b = readFileSync(join(__dirname, '../fixtures/audio/open-gmail-drafts.wav'))
    const wav = parseWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))!
    const first = await stallDuring(() => transcribeLocal(wav.samples, wav.sampleRate))
    const again = await stallDuring(() => transcribeLocal(wav.samples, wav.sampleRate))
    expect(again.value.toLowerCase()).toContain('drafts')

    const row = (name: string, r: { ms: number; stall: number }): string =>
      `${name.padEnd(28)} ${r.ms.toFixed(0).padStart(6)} ms   main stall ${r.stall.toFixed(1)} ms`
    console.log(
      [
        row('spotter build (worker)', spot),
        row('50 x 100 ms feed + recent', feed),
        row('stt load + decode', first),
        row('stt decode', again)
      ].join('\n')
    )
    // In-thread the spotter build alone blocks for seconds; Windows timer jitter is ~15 ms.
    for (const r of [spot, feed, first, again]) expect(r.stall).toBeLessThan(250)
  })
})
