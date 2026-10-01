// Keyword spotting on the mic stream: the wake phrase and the voice-cancel phrases.
import { readFileSync } from 'fs'
import { join } from 'path'
import type { KeywordSpotter, OnlineStream } from 'sherpa-onnx-node'
import { parseSentencepieceModel, type PieceVocab } from './sentencepiece'
import { buildKeywords, EnergyGate, type SpottedPhrase } from './keywords'
import { KWS_MODEL } from './kws-model'
import type { Sherpa } from '../sherpa'

const SAMPLE_RATE = 16000
const HISTORY_BLOCKS = 25 // 2.5 s of recent audio for confirming a cancel hit

function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
  return out
}

let vocabCache: { dir: string; vocab: PieceVocab } | null = null

function vocabOf(dir: string): PieceVocab {
  if (vocabCache?.dir !== dir) {
    vocabCache = {
      dir,
      vocab: parseSentencepieceModel(readFileSync(join(dir, KWS_MODEL.files.pieces)))
    }
  }
  return vocabCache.vocab
}

export class Spotter {
  private readonly kws: KeywordSpotter
  private readonly stream: OnlineStream
  private readonly gate = new EnergyGate()
  private readonly history: Int16Array[] = []
  readonly unusable: string[]
  private readonly byTag: Map<string, SpottedPhrase>

  /** Throws when the model fails to load or no phrase is usable. */
  constructor(lib: Sherpa, dir: string, phrases: { wake: string; cancel: string[] }) {
    const list = buildKeywords(phrases, vocabOf(dir))
    this.unusable = list.unusable
    this.byTag = list.byTag
    if (!list.byTag.size) throw new Error('no usable wake or cancel phrase')
    const f = KWS_MODEL.files
    this.kws = new lib.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(dir, f.encoder),
          decoder: join(dir, f.decoder),
          joiner: join(dir, f.joiner)
        },
        tokens: join(dir, f.tokens),
        numThreads: 1,
        provider: 'cpu',
        debug: 0
      },
      keywordsBuf: list.text,
      keywordsBufSize: Buffer.byteLength(list.text)
    })
    this.stream = this.kws.createStream()
  }

  /** The last 2.5 s of audio as float samples. */
  recentAudio(): Float32Array {
    const out = new Float32Array(this.history.reduce((n, b) => n + b.length, 0))
    let at = 0
    for (const b of this.history) {
      out.set(toFloat(b), at)
      at += b.length
    }
    return out
  }

  /** Feeds 16 kHz audio; returns the phrases spotted in it. */
  feed(pcm: Int16Array): SpottedPhrase[] {
    this.history.push(pcm)
    if (this.history.length > HISTORY_BLOCKS) this.history.shift()
    const hits: SpottedPhrase[] = []
    for (const block of this.gate.push(pcm)) {
      this.stream.acceptWaveform({ samples: toFloat(block), sampleRate: SAMPLE_RATE })
      while (this.kws.isReady(this.stream)) {
        this.kws.decode(this.stream)
        const tag = this.kws.getResult(this.stream).keyword
        if (!tag) continue
        this.kws.reset(this.stream)
        const hit = this.byTag.get(tag)
        if (hit) hits.push(hit)
      }
    }
    return hits
  }
}
