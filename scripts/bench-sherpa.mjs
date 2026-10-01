/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Measures how long sherpa-onnx (wake-word spotter + offline STT) blocks the thread it runs
// on. Plain Node, no Electron, no microphone, no audio output: the input is the models'
// bundled test wavs plus generated noise.
//
//   node scripts/bench-sherpa.mjs            # needs both models in ~/.ai-overlay
//
// Prints: addon load, spotter build (sync), per-100 ms-chunk KWS decode + CPU share at
// real time, STT model load, STT decode of a 5 s utterance, and the event-loop stall seen
// by a 4 ms timer during each async call.
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { homedir, cpus } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'

const require = createRequire(import.meta.url)
const KWS_DIR = join(homedir(), '.ai-overlay', 'wake-model', 'kws-zipformer-gigaspeech-3.3M')
const STT_DIR = join(homedir(), '.ai-overlay', 'stt-model', 'parakeet-tdt-ctc-110m-en-int8')
const RATE = 16000
const CHUNK = 1600 // the voice renderer sends 100 ms blocks

const ms = (v) => `${v.toFixed(1)} ms`
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return `min ${ms(s[0])}  p50 ${ms(at(0.5))}  p95 ${ms(at(0.95))}  max ${ms(s[s.length - 1])}`
}

/** Largest gap a 4 ms interval sees while `fn` runs: how long the thread was blocked. */
async function stallDuring(fn) {
  let last = performance.now()
  let worst = 0
  const t = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 4)
    last = now
  }, 4)
  const t0 = performance.now()
  const result = await fn()
  const total = performance.now() - t0
  clearInterval(t)
  return { result, total, stall: Math.max(0, worst) }
}

function noise(n, amp = 0.01) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * amp
  return out
}

const report = {}

let t0 = performance.now()
const sherpa = require('sherpa-onnx-node')
report.addonLoadMs = performance.now() - t0
console.log(`cpus ${cpus().length} (${cpus()[0].model.trim()})`)
console.log(`addon load              ${ms(report.addonLoadMs)}`)

// ---- keyword spotter ----
if (!existsSync(join(KWS_DIR, 'tokens.txt'))) {
  console.log(`wake model missing at ${KWS_DIR}`)
} else {
  // Same shape as the app's list: wake phrase + three cancel phrases (valid pieces from tokens.txt).
  const keywords =
    [
      '▁HE Y ▁ LU M EN :5 #0.1 @wake0',
      '▁ST O P :0.5 #0.3 @cancel1',
      '▁CA N CE L :0.5 #0.3 @cancel2',
      '▁NEVER ▁MI ND :0.5 #0.3 @cancel3',
      '▁LI G H T ▁UP :5 #0.1 @probe4'
    ].join('\n') + '\n'
  const cfg = {
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(KWS_DIR, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        decoder: join(KWS_DIR, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
        joiner: join(KWS_DIR, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx')
      },
      tokens: join(KWS_DIR, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0
    },
    keywordsBuf: keywords,
    keywordsBufSize: Buffer.byteLength(keywords)
  }
  const builds = []
  let kws
  for (let i = 0; i < 5; i++) {
    t0 = performance.now()
    kws = new sherpa.KeywordSpotter(cfg)
    builds.push(performance.now() - t0)
  }
  report.spotterBuildMs = builds
  console.log(`spotter build (sync)    first ${ms(builds[0])}; rebuilds ${stats(builds.slice(1))}`)

  // 30 s of audio: noise, the test sentence (contains "light up"), noise. Ungated (worst case:
  // continuous speech or a loud room); the app's energy gate skips silent blocks entirely.
  const wav = sherpa.readWave(join(KWS_DIR, 'test_wavs', '0.wav'))
  const audio = new Float32Array(RATE * 30)
  audio.set(noise(audio.length))
  audio.set(wav.samples, RATE * 5)
  const stream = kws.createStream()
  const per = []
  const hits = []
  const cpu0 = process.cpuUsage()
  const wall0 = performance.now()
  for (let at = 0; at + CHUNK <= audio.length; at += CHUNK) {
    const c0 = performance.now()
    stream.acceptWaveform({ samples: audio.subarray(at, at + CHUNK), sampleRate: RATE })
    while (kws.isReady(stream)) {
      kws.decode(stream)
      const tag = kws.getResult(stream).keyword
      if (tag) {
        hits.push(`${tag}@${(at / RATE).toFixed(1)}s`)
        kws.reset(stream)
      }
    }
    per.push(performance.now() - c0)
  }
  const cpu = process.cpuUsage(cpu0)
  const busyMs = (cpu.user + cpu.system) / 1000
  report.kwsChunkMs = per
  report.kwsCpuShare = busyMs / 30000
  console.log(`kws per 100 ms chunk    ${stats(per)}`)
  console.log(
    `kws 30 s ungated        cpu ${ms(busyMs)} = ${(report.kwsCpuShare * 100).toFixed(2)}% of one core at real time (wall ${ms(performance.now() - wall0)}); hits ${hits.join(', ') || 'none'}`
  )
}

// ---- offline STT ----
if (!existsSync(join(STT_DIR, 'model.int8.onnx'))) {
  console.log(`stt model missing at ${STT_DIR}`)
} else {
  const threads = Math.min(4, Math.max(1, Math.floor(cpus().length / 4)))
  const cfg = {
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      nemoCtc: { model: join(STT_DIR, 'model.int8.onnx') },
      tokens: join(STT_DIR, 'tokens.txt'),
      numThreads: threads,
      provider: 'cpu',
      debug: 0
    },
    decodingMethod: 'greedy_search'
  }
  const load = await stallDuring(() => sherpa.OfflineRecognizer.createAsync(cfg))
  report.sttLoad = { totalMs: load.total, stallMs: load.stall }
  console.log(`stt load (createAsync)  ${ms(load.total)}; main-thread stall ${ms(load.stall)}`)
  const rec = load.result

  const wav = sherpa.readWave(join(STT_DIR, 'test_wavs', '0.wav'))
  const five = new Float32Array(RATE * 5)
  five.set(wav.samples.subarray(0, Math.min(wav.samples.length, five.length)))
  const runs = []
  let text = ''
  for (let i = 0; i < 4; i++) {
    const stream = rec.createStream()
    stream.acceptWaveform({ samples: five, sampleRate: RATE })
    const r = await stallDuring(() => rec.decodeAsync(stream))
    runs.push(r)
    text = r.result.text
  }
  report.sttDecode = runs.map((r) => ({ totalMs: r.total, stallMs: r.stall }))
  console.log(
    `stt 5 s decodeAsync     ${stats(runs.slice(1).map((r) => r.total))}; worst stall ${ms(Math.max(...runs.map((r) => r.stall)))}`
  )
  // 2.5 s cancel-confirm window, the other STT call site.
  const short = rec.createStream()
  short.acceptWaveform({ samples: five.subarray(0, RATE * 2.5), sampleRate: RATE })
  const sr = await stallDuring(() => rec.decodeAsync(short))
  console.log(`stt 2.5 s decodeAsync   ${ms(sr.total)}; stall ${ms(sr.stall)}`)
  console.log(`  text: "${text.trim()}"`)
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report))
