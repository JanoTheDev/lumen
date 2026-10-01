// Splits streamed text into complete sentences so speech can start on the first one.

// Words whose trailing period does not end a sentence. Dotted forms (e.g., p.m., U.S.) and
// single initials are caught by shape; joining two sentences is safer for speech than a
// split mid-sentence.
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'approx', 'no'])

// Sentence end: . ! ? or … plus optional closing quotes/brackets, followed by whitespace.
const END_RE = /[.!?…]+["')\]]*(?=\s)|\n+/g

function isAbbreviation(text: string, dotIndex: number): boolean {
  if (text[dotIndex] !== '.') return false
  const word = /([A-Za-z.]+)$/.exec(text.slice(0, dotIndex))?.[1]
  if (!word) return false
  return ABBREVIATIONS.has(word.toLowerCase()) || /^[A-Z]$/.test(word) || word.includes('.')
}

export class SentenceSplitter {
  private buf = ''

  /** Adds text; returns the sentences it completed (trimmed, non-empty). */
  push(text: string): string[] {
    this.buf += text
    const out: string[] = []
    let start = 0
    END_RE.lastIndex = 0
    for (let m = END_RE.exec(this.buf); m; m = END_RE.exec(this.buf)) {
      if (isAbbreviation(this.buf, m.index)) continue
      const end = m.index + m[0].length
      const sentence = this.buf.slice(start, end).trim()
      if (sentence) out.push(sentence)
      start = end
    }
    this.buf = this.buf.slice(start)
    return out
  }

  /** Returns whatever is left as a final sentence. */
  flush(): string | null {
    const rest = this.buf.trim()
    this.buf = ''
    return rest || null
  }
}
