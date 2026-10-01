// Personal dictionary learning: after dictation is typed, the focused field is read right away
// and again 20 s later. A dictated word the user then retyped as a name ("figma" → "Figma",
// "github" → "GitHub") is a candidate; the same correction seen twice joins
// config.dictation.dictionary, which steers the transcription prompt and the casing pass.
// Candidate counts live in ~/.ai-overlay/dictionary.json. The diff is pure.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export const LEARN_AFTER = 2
export const MAX_CANDIDATES = 200

export interface Correction {
  /** As dictated. */
  from: string
  /** As the user fixed it. */
  to: string
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.+#-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu

function words(text: string): string[] {
  return text.match(WORD_RE) ?? []
}

function editDistance(a: string, b: string): number {
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

/** A spelling worth learning: a name or brand, not an ordinary word. */
export function looksLikeName(to: string, from: string): boolean {
  if (to.length < 2 || to.length > 40 || /^\d+$/.test(to)) return false
  if (to === from) return false
  const sameLetters = to.toLowerCase() === from.toLowerCase()
  const innerCap = /\p{Lu}/u.test(to.slice(1)) // GitHub, iPhone, DaVinci
  const firstCap = /^\p{Lu}/u.test(to)
  if (sameLetters) return firstCap || innerCap
  // A respelled word ("Figmah" → "Figma") must stay close and read like a name.
  const close = editDistance(to.toLowerCase(), from.toLowerCase()) <= Math.max(1, to.length / 3)
  return close && (firstCap || innerCap || /\d/.test(to))
}

/** Longest common subsequence alignment of two word lists: index pairs that match. */
function align(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

const MAX_WORDS = 3000

/**
 * Single-word replacements between the field right after typing (`before`) and later
 * (`after`), limited to words that were dictated (`dictated`). Pure.
 */
export function findCorrections(dictated: string, before: string, after: string): Correction[] {
  const said = new Set(words(dictated).map((w) => w.toLowerCase()))
  const a = words(before).slice(-MAX_WORDS)
  const b = words(after).slice(-MAX_WORDS)
  if (!said.size || !a.length || !b.length) return []
  const pairs = align(a, b)
  pairs.push([a.length, b.length])
  const out: Correction[] = []
  let pi = -1
  let pj = -1
  for (const [i, j] of pairs) {
    // Exactly one word replaced by exactly one word between two matches.
    if (i - pi === 2 && j - pj === 2) {
      const from = a[pi + 1]
      const to = b[pj + 1]
      if (said.has(from.toLowerCase()) && looksLikeName(to, from)) out.push({ from, to })
    }
    pi = i
    pj = j
  }
  return out
}

interface Store {
  version: 1
  /** "from→to" (lowercased from) → how often it was seen. */
  candidates: Record<string, { from: string; to: string; count: number; last: string }>
}

export function storePath(): string {
  return join(homedir(), '.ai-overlay', 'dictionary.json')
}

function readStore(path: string): Store {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Store
    if (raw && raw.version === 1 && raw.candidates && typeof raw.candidates === 'object') return raw
  } catch {
    /* missing or broken: start over */
  }
  return { version: 1, candidates: {} }
}

function writeStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, path)
}

/**
 * Counts the corrections; returns the spellings that just reached LEARN_AFTER and are not in
 * `dictionary` yet. Those are removed from the candidate list.
 */
export function noteCorrections(
  found: readonly Correction[],
  dictionary: readonly string[],
  path = storePath(),
  now = new Date()
): string[] {
  if (!found.length) return []
  const known = new Set(dictionary.map((d) => d.trim().toLowerCase()))
  const exact = new Set(dictionary.map((d) => d.trim()))
  const store = existsSync(path) ? readStore(path) : { version: 1 as const, candidates: {} }
  const learned: string[] = []
  for (const c of found) {
    if (exact.has(c.to)) continue
    const key = `${c.from.toLowerCase()}→${c.to}`
    const entry = store.candidates[key] ?? { from: c.from, to: c.to, count: 0, last: '' }
    entry.count++
    entry.last = now.toISOString()
    store.candidates[key] = entry
    if (entry.count >= LEARN_AFTER && !learned.includes(c.to)) {
      learned.push(c.to)
      delete store.candidates[key]
    }
  }
  // Oldest candidates go first when the list grows too long.
  const keys = Object.keys(store.candidates)
  if (keys.length > MAX_CANDIDATES) {
    keys
      .sort((x, y) => store.candidates[x].last.localeCompare(store.candidates[y].last))
      .slice(0, keys.length - MAX_CANDIDATES)
      .forEach((k) => delete store.candidates[k])
  }
  writeStore(path, store)
  // A spelling that differs only in case from a stored one replaces it (handled by the caller).
  return learned.filter((w) => !known.has(w.toLowerCase()) || !exact.has(w))
}

/** The dictionary with `learned` added; a case variant of a learned word is replaced. */
export function withLearned(dictionary: readonly string[], learned: readonly string[]): string[] {
  const lower = new Set(learned.map((w) => w.toLowerCase()))
  return [...dictionary.filter((d) => !lower.has(d.trim().toLowerCase())), ...learned]
}
