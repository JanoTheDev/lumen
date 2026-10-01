// Pure parts of keyword spotting: the keyword list for the spotter and the energy gate.
import { encodePhrase, type PieceVocab } from './sentencepiece'

export type PhraseKind = 'wake' | 'cancel'
export interface SpottedPhrase {
  kind: PhraseKind
  phrase: string
}

// Wake: boost 5 / threshold 0.1 gave 30/30 recall and 0/90 false wakes in the evaluation.
// Cancel: 36/36 recall on "stop", "cancel", "never mind" (+ "okay stop", "cancel that"), but
// the spotter also fires inside "stopwatch" or "cancellation", so cancel hits are confirmed
// with the speech model before they count (see confirm.ts).
export interface KeywordTuning {
  boost: number
  threshold: number
}

const CANCEL_TUNING: KeywordTuning = { boost: 0.5, threshold: 0.3 }

/**
 * Wake sensitivity 0..1 → spotter tuning. 0.5 is the evaluated boost 5 / threshold 0.1;
 * higher boosts the phrase and lowers the trigger threshold (more wakes, more false wakes).
 * Range: boost 2..8, threshold 0.2..0.05 (halved per +0.5).
 */
export function wakeTuning(sensitivity = 0.5): KeywordTuning {
  const s = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.5
  return {
    boost: Math.round((2 + 6 * s) * 100) / 100,
    threshold: Math.round(0.2 * Math.pow(4, -s) * 1000) / 1000
  }
}

export interface KeywordList {
  /** keywords.txt content: pieces, :boost, #threshold, @tag per line. */
  text: string
  byTag: Map<string, SpottedPhrase>
  /** Phrases the model cannot spell. */
  unusable: string[]
}

export interface KeywordPhrases {
  wake: string
  cancel: string[]
  /** Wake sensitivity 0..1 (see wakeTuning); default 0.5. */
  sensitivity?: number
}

export function buildKeywords(phrases: KeywordPhrases, vocab: PieceVocab): KeywordList {
  const tuning: Record<PhraseKind, KeywordTuning> = {
    wake: wakeTuning(phrases.sensitivity),
    cancel: CANCEL_TUNING
  }
  const byTag = new Map<string, SpottedPhrase>()
  const unusable: string[] = []
  const lines: string[] = []
  const all: SpottedPhrase[] = [
    ...(phrases.wake.trim() ? [{ kind: 'wake' as const, phrase: phrases.wake.trim() }] : []),
    ...phrases.cancel.map((p) => ({ kind: 'cancel' as const, phrase: p.trim() }))
  ]
  const seen = new Set<string>()
  for (const p of all) {
    const pieces = encodePhrase(p.phrase, vocab)
    if (!pieces) {
      if (p.phrase) unusable.push(p.phrase)
      continue
    }
    const key = pieces.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    const tag = `${p.kind}${byTag.size}`
    const t = tuning[p.kind]
    lines.push(`${key} :${t.boost} #${t.threshold} @${tag}`)
    byTag.set(tag, p)
  }
  return { text: lines.length ? lines.join('\n') + '\n' : '', byTag, unusable }
}

/** Int16 RMS; quiet room with noise suppression ~0-50, speech several hundred and up. */
export function int16Rms(pcm: Int16Array): number {
  if (!pcm.length) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / pcm.length)
}

/**
 * Only blocks around sound reach the spotter (saves CPU in silence). On onset the last
 * `preRoll` quiet blocks go first so the start of the phrase is not cut; after the sound
 * stops, `hangover` more blocks are fed so the spotter can finish the phrase.
 */
export class EnergyGate {
  private open = 0
  private readonly recent: Int16Array[] = []

  constructor(
    private readonly floor = 120,
    private readonly hangover = 15,
    private readonly preRoll = 3
  ) {}

  push(block: Int16Array): Int16Array[] {
    if (int16Rms(block) >= this.floor) {
      const out = this.open > 0 ? [block] : [...this.recent, block]
      this.recent.length = 0
      this.open = this.hangover
      return out
    }
    if (this.open > 0) {
      this.open--
      return [block]
    }
    this.recent.push(block)
    if (this.recent.length > this.preRoll) this.recent.shift()
    return []
  }
}
