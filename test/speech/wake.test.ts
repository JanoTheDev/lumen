import { describe, expect, it, vi } from 'vitest'
import {
  encodePhrase,
  parseSentencepieceModel,
  phraseWords,
  type PieceVocab
} from '../../src/main/speech/wake/sentencepiece'
import {
  buildKeywords,
  EnergyGate,
  int16Rms,
  wakeTuning
} from '../../src/main/speech/wake/keywords'
import { confirmsCancel } from '../../src/main/speech/wake/confirm'
import {
  armCancel,
  cancelArmed,
  onCancelArmed,
  withCancelArmed
} from '../../src/main/speech/wake/arm'

// Minimal sentencepiece ModelProto writer: field 1 = SentencePiece { 1: piece, 2: score }.
function varint(n: number): number[] {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

function modelProto(pieces: Array<[string, number]>): Uint8Array {
  const bytes: number[] = []
  for (const [piece, score] of pieces) {
    const text = Array.from(new TextEncoder().encode(piece))
    const f = new Uint8Array(new Float32Array([score]).buffer)
    const body = [0x0a, ...varint(text.length), ...text, 0x15, ...f, 0x18, 1]
    bytes.push(0x0a, ...varint(body.length), ...body)
  }
  // trailing unrelated field (trainer spec) must be skipped
  bytes.push(0x12, 2, 0x08, 2)
  return new Uint8Array(bytes)
}

// Pieces and scores shaped like the real KWS vocabulary for these words.
const VOCAB: Array<[string, number]> = [
  ['▁', -3],
  ['▁HE', -6],
  ['▁H', -9],
  ['E', -4],
  ['H', -5],
  ['Y', -5],
  ['LU', -8],
  ['L', -5],
  ['U', -5],
  ['M', -5],
  ['EN', -6],
  ['N', -4],
  ['▁ST', -7],
  ['O', -4],
  ['P', -5],
  ['S', -3],
  ['T', -4],
  ['▁STOP', -9]
]

function vocab(): PieceVocab {
  return parseSentencepieceModel(modelProto(VOCAB))
}

describe('sentencepiece', () => {
  it('reads pieces and scores from the model proto', () => {
    const v = vocab()
    expect(v.scores.size).toBe(VOCAB.length)
    expect(v.scores.get('▁HE')).toBeCloseTo(-6)
  })

  it('picks the best-scoring split, like the model keywords.txt', () => {
    expect(encodePhrase('hey lumen', vocab())).toEqual(['▁HE', 'Y', '▁', 'LU', 'M', 'EN'])
    expect(encodePhrase('Stop!', vocab())).toEqual(['▁STOP'])
  })

  it('returns null for empty phrases and unspellable words', () => {
    expect(encodePhrase('  ', vocab())).toBeNull()
    expect(encodePhrase('hey zed', vocab())).toBeNull()
  })

  it('normalises words', () => {
    expect(phraseWords(" hey, Lumen's  app ")).toEqual(['HEY', "LUMEN'S", 'APP'])
  })
})

describe('buildKeywords', () => {
  it('writes one tagged line per usable phrase, wake first', () => {
    const list = buildKeywords({ wake: 'hey lumen', cancel: ['stop', 'zap', 'STOP'] }, vocab())
    const lines = list.text.trim().split('\n')
    expect(lines).toEqual(['▁HE Y ▁ LU M EN :5 #0.1 @wake0', '▁STOP :0.5 #0.3 @cancel1'])
    expect(list.byTag.get('wake0')).toEqual({ kind: 'wake', phrase: 'hey lumen' })
    expect(list.byTag.get('cancel1')).toEqual({ kind: 'cancel', phrase: 'stop' })
    expect(list.unusable).toEqual(['zap'])
  })

  it('tunes only the wake phrase by sensitivity', () => {
    const list = buildKeywords({ wake: 'hey lumen', cancel: ['stop'], sensitivity: 1 }, vocab())
    expect(list.text.trim().split('\n')).toEqual([
      '▁HE Y ▁ LU M EN :8 #0.05 @wake0',
      '▁STOP :0.5 #0.3 @cancel1'
    ])
  })

  it('is empty without phrases', () => {
    const list = buildKeywords({ wake: '', cancel: [] }, vocab())
    expect(list.text).toBe('')
    expect(list.byTag.size).toBe(0)
  })
})

describe('wakeTuning', () => {
  it('keeps the evaluated tuning at the default and moves monotonically', () => {
    expect(wakeTuning()).toEqual({ boost: 5, threshold: 0.1 })
    expect(wakeTuning(0.5)).toEqual({ boost: 5, threshold: 0.1 })
    expect(wakeTuning(0)).toEqual({ boost: 2, threshold: 0.2 })
    expect(wakeTuning(1)).toEqual({ boost: 8, threshold: 0.05 })
    let prev = wakeTuning(0)
    for (let s = 0.1; s <= 1; s += 0.1) {
      const t = wakeTuning(s)
      expect(t.boost).toBeGreaterThan(prev.boost)
      expect(t.threshold).toBeLessThan(prev.threshold)
      prev = t
    }
  })

  it('clamps out-of-range and NaN input', () => {
    expect(wakeTuning(-3)).toEqual(wakeTuning(0))
    expect(wakeTuning(7)).toEqual(wakeTuning(1))
    expect(wakeTuning(Number.NaN)).toEqual(wakeTuning(0.5))
  })
})

describe('EnergyGate', () => {
  const quiet = (): Int16Array => new Int16Array(1600)
  const loud = (): Int16Array => new Int16Array(1600).fill(2000)

  it('measures int16 RMS', () => {
    expect(int16Rms(loud())).toBe(2000)
    expect(int16Rms(new Int16Array(0))).toBe(0)
  })

  it('passes nothing in silence', () => {
    const g = new EnergyGate()
    for (let i = 0; i < 20; i++) expect(g.push(quiet())).toEqual([])
  })

  it('adds pre-roll on onset and a hangover after the sound', () => {
    const g = new EnergyGate(120, 2, 3)
    const q = [quiet(), quiet(), quiet(), quiet()]
    q.forEach((b) => g.push(b))
    const l = loud()
    expect(g.push(l)).toEqual([q[1], q[2], q[3], l])
    expect(g.push(quiet())).toHaveLength(1)
    expect(g.push(quiet())).toHaveLength(1)
    expect(g.push(quiet())).toEqual([])
  })
})

describe('confirmsCancel', () => {
  it.each([
    ['Stop.', 'stop'],
    ['Okay, stop!', 'stop'],
    ['stop it', 'stop'],
    ['Cancel that.', 'cancel'],
    ['oh never mind', 'never mind']
  ])('accepts %s', (text, phrase) => expect(confirmsCancel(text, phrase)).toBe(true))

  it.each([
    ['Start the stopwatch.', 'stop'],
    ['Open the bus stop page.', 'stop'],
    ['What is the cancellation policy?', 'cancel'],
    ['Never again.', 'never mind'],
    ['', 'stop']
  ])('rejects %s', (text, phrase) => expect(confirmsCancel(text, phrase)).toBe(false))
})

describe('cancel arming', () => {
  it('is ref-counted and notifies on edges only', async () => {
    const seen: boolean[] = []
    const off = onCancelArmed((a) => seen.push(a))
    const a = armCancel()
    const b = armCancel()
    expect(cancelArmed()).toBe(true)
    a()
    a()
    expect(cancelArmed()).toBe(true)
    b()
    expect(cancelArmed()).toBe(false)
    const fn = vi.fn(async () => cancelArmed())
    await expect(withCancelArmed(fn)).resolves.toBe(true)
    await expect(
      withCancelArmed(async () => {
        throw new Error('x')
      })
    ).rejects.toThrow('x')
    expect(cancelArmed()).toBe(false)
    expect(seen).toEqual([true, false, true, false, true, false])
    off()
  })
})
