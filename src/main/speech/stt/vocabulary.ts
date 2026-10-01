// Words speech recognition should expect: the user's vocabulary (Settings), the personal
// dictionary (dictation, learned spellings) and the glossary of the app in front (skill packs,
// skills/<app>/glossary.md). Merged without duplicates and capped to what the Whisper prompt
// holds (224 tokens for the whole prompt). The offline models take no word list (CTC/AED
// without hotwords), so this only reaches cloud transcription.

/** Whisper reads at most 224 prompt tokens; this leaves room for the lead-in sentence. */
export const MAX_TERMS = 60
export const MAX_CHARS = 600
const MAX_TERM_CHARS = 40

/** Comma or newline separated text → terms. */
export function splitTerms(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** "- **Auto layout** — …" and "- **Style / Variable** — …" → ["Auto layout", "Style", "Variable"]. */
export function glossaryTerms(markdown: string): string[] {
  const out: string[] = []
  for (const line of markdown.split('\n')) {
    const m = /^\s*[-*]\s+\*\*(.+?)\*\*/.exec(line)
    if (!m) continue
    for (const t of m[1].split(/\s*\/\s*/)) if (t.trim()) out.push(t.trim())
  }
  return out
}

/**
 * Sources in priority order (earlier ones survive the cap). Case-insensitive dedupe keeps the
 * first spelling; overlong terms are skipped.
 */
export function mergeVocabulary(
  sources: ReadonlyArray<readonly string[]>,
  maxTerms = MAX_TERMS,
  maxChars = MAX_CHARS
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let chars = 0
  for (const list of sources) {
    for (const raw of list) {
      const term = raw.trim()
      const key = term.toLowerCase()
      if (!term || term.length > MAX_TERM_CHARS || seen.has(key)) continue
      if (out.length >= maxTerms || chars + term.length + 2 > maxChars) return out
      seen.add(key)
      out.push(term)
      chars += term.length + 2
    }
  }
  return out
}
