// Names in screen text and the spelling fix they drive (04 T41). Pure; the read itself is in
// screen-names.ts.

export const MAX_SCREEN_CHARS = 30_000
export const MAX_NAMES = 300

const TOKEN_RE = /[\p{L}][\p{L}\p{N}'’-]*[\p{L}\p{N}]/gu

// Capitalised words that are not names (sentence starts are skipped anyway).
const NOT_NAMES = new Set(
  'the a an and or but if then this that these those there here when where what who why how i it its we you he she they me my our your his her their is are was were be to of in on at for with from by as not no yes ok okay hi hello hey dear thanks thank regards best re fw fwd new reply send cancel save edit view file home help search settings close open more less all today yesterday tomorrow am pm'.split(
    ' '
  )
)

function innerCap(w: string): boolean {
  return /\p{Lu}/u.test(w.slice(1)) && /\p{Ll}/u.test(w)
}

/**
 * Names in screen text: words written with a capital (not only at a sentence start), or
 * with inner capitals (GitHub). A word that also shows up in lowercase is an ordinary word
 * ("Will" next to "will") unless it has inner capitals. Most frequent first. Pure.
 */
export function extractScreenNames(text: string, max = MAX_NAMES): string[] {
  const caps = new Map<string, { word: string; count: number; midSentence: boolean }>()
  const lower = new Set<string>()
  for (const m of text.slice(0, MAX_SCREEN_CHARS).matchAll(TOKEN_RE)) {
    const word = m[0]
    const key = word.toLowerCase()
    if (word.length < 3 || word.length > 30) continue
    if (!/^\p{Lu}/u.test(word) && !innerCap(word)) {
      lower.add(key)
      continue
    }
    if (NOT_NAMES.has(key)) continue
    const before = text.slice(Math.max(0, (m.index ?? 0) - 3), m.index).trimEnd()
    const start = !before || /[.!?:\n•"“(]$/.test(before)
    const e = caps.get(key) ?? { word, count: 0, midSentence: false }
    e.count++
    if (!start) e.midSentence = true
    // Keep the spelling with inner capitals when both show up.
    if (innerCap(word) && !innerCap(e.word)) e.word = word
    caps.set(key, e)
  }
  return [...caps.entries()]
    .filter(([key, e]) => innerCap(e.word) || (e.midSentence && !lower.has(key)))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, max)
    .map(([, e]) => e.word)
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** The one screen name a dictated word is a near-miss of, else null. */
function nearName(word: string, names: readonly string[]): string | null {
  const w = word.toLowerCase()
  if (w.length < 3) return null
  // A three-letter word only gains a letter ("Jon" → "John").
  const short = w.length === 3
  const limit = w.length >= 7 ? 2 : 1
  let best: string | null = null
  let bestD = Infinity
  let tie = false
  for (const n of names) {
    const k = n.toLowerCase()
    if (k[0] !== w[0] || Math.abs(k.length - w.length) > limit) continue
    if (short && k.length !== 4) continue
    const d = distance(w, k)
    if (d > limit || d === 0) continue
    if (d < bestD) {
      best = n
      bestD = d
      tie = false
    } else if (d === bestD && k !== best?.toLowerCase()) tie = true
  }
  return tie ? null : best
}

/**
 * Fixes dictated spellings from screen names. Only words written as names are touched:
 * a capitalised word that is not a sentence start and is a near-miss of exactly one name
 * ("Jon" → "John"), and any word whose letters match a name with inner capitals
 * ("github" → "GitHub"). Words that are on screen as they are stay. Pure.
 */
export function respellFromScreen(text: string, names: readonly string[]): string {
  if (!names.length || !text) return text
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]))
  return text.replace(TOKEN_RE, (word, offset: number) => {
    const exact = byLower.get(word.toLowerCase())
    if (exact) return exact !== word && innerCap(exact) ? exact : word
    if (!/^\p{Lu}\p{Ll}/u.test(word)) return word
    const before = text.slice(Math.max(0, offset - 3), offset).trimEnd()
    if (!before || /[.!?:\n]$/.test(before)) return word
    return nearName(word, names) ?? word
  })
}
