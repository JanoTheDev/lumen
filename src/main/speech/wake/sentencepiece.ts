// Turns a wake or cancel phrase into the pieces the keyword spotter expects
// ("hey lumen" → "▁HE Y ▁ LU M EN"). sherpa-onnx-node 1.13.8 ignores `modelingUnit: 'bpe'` on
// the keyword path, so phrases are encoded here from the model's sentencepiece `bpe.model`
// (a unigram model despite the name: best-scoring segmentation, matching the model's own
// keywords.txt).

export interface PieceVocab {
  /** piece → log-probability score. */
  scores: Map<string, number>
}

function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
  let value = 0
  let shift = 0
  for (;;) {
    const b = buf[pos++]
    if (b === undefined) throw new Error('truncated varint')
    value += (b & 0x7f) * 2 ** shift
    if (b < 0x80) return [value, pos]
    shift += 7
  }
}

function skipField(buf: Uint8Array, wire: number, pos: number): number {
  if (wire === 0) return readVarint(buf, pos)[1]
  if (wire === 1) return pos + 8
  if (wire === 5) return pos + 4
  if (wire === 2) {
    const [len, p] = readVarint(buf, pos)
    return p + len
  }
  throw new Error(`unsupported wire type ${wire}`)
}

/** Reads the pieces of a sentencepiece ModelProto (field 1: piece, score). */
export function parseSentencepieceModel(buf: Uint8Array): PieceVocab {
  const scores = new Map<string, number>()
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const text = new TextDecoder()
  let pos = 0
  while (pos < buf.length) {
    const [key, p] = readVarint(buf, pos)
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (field !== 1 || wire !== 2) {
      pos = skipField(buf, wire, p)
      continue
    }
    const [len, start] = readVarint(buf, p)
    const end = start + len
    let piece = ''
    let score = 0
    let q = start
    while (q < end) {
      const [k, r] = readVarint(buf, q)
      const f = Math.floor(k / 8)
      const w = k & 7
      if (f === 1 && w === 2) {
        const [l, s] = readVarint(buf, r)
        piece = text.decode(buf.subarray(s, s + l))
        q = s + l
      } else if (f === 2 && w === 5) {
        score = view.getFloat32(r, true)
        q = r + 4
      } else {
        q = skipField(buf, w, r)
      }
    }
    if (piece) scores.set(piece, score)
    pos = end
  }
  return { scores }
}

/** Upper-case words of a phrase; anything but letters, digits and apostrophes splits words. */
export function phraseWords(phrase: string): string[] {
  return phrase
    .toUpperCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** Best-scoring split of one word into vocabulary pieces (unigram Viterbi), or null. */
function encodeWord(word: string, vocab: PieceVocab): string[] | null {
  const chars = ['▁', ...Array.from(word)]
  const n = chars.length
  const best = new Array<number>(n + 1).fill(-Infinity)
  const back = new Array<number>(n + 1).fill(-1)
  best[0] = 0
  for (let i = 0; i < n; i++) {
    if (best[i] === -Infinity) continue
    let piece = ''
    for (let j = i; j < n; j++) {
      piece += chars[j]
      const score = vocab.scores.get(piece)
      if (score === undefined || best[i] + score <= best[j + 1]) continue
      best[j + 1] = best[i] + score
      back[j + 1] = i
    }
  }
  if (best[n] === -Infinity) return null
  const pieces: string[] = []
  for (let k = n; k > 0; k = back[k]) pieces.unshift(chars.slice(back[k], k).join(''))
  return pieces
}

/** Pieces for `phrase`, or null when it is empty or a word cannot be spelled with the vocabulary. */
export function encodePhrase(phrase: string, vocab: PieceVocab): string[] | null {
  const words = phraseWords(phrase)
  if (!words.length) return null
  const out: string[] = []
  for (const w of words) {
    const pieces = encodeWord(w, vocab)
    if (!pieces) return null
    out.push(...pieces)
  }
  return out
}
