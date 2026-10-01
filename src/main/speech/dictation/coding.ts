// Coding mode (04 T42): in code editors, terminals and Claude Code prompts, spoken code words
// become code. "camel case user name" → userName (also snake, kebab, pascal, constant case),
// spoken symbols ("open paren", "dot", "underscore", "equals") → characters, and
// "at file pipeline dot ts" → "@pipeline.ts", resolved to a project path when one is known.
// Runs after cleanup and style, so the cleanup check still sees the spoken words. Pure.

export type CaseStyle = 'camel' | 'snake' | 'kebab' | 'pascal' | 'constant'

const CASE_RE =
  /\b(camel|snake|kebab|pascal|constant|screaming snake|upper snake)[ -]?case\s+((?:[\p{L}\p{N}]+[ ,]*){1,8})/giu
// Words that end an identifier ("camel case user name to account id").
const STOP_WORDS = new Set(
  'to in on with and or the a an from into for as is equals of at by then end done'.split(' ')
)
const MAX_IDENT_WORDS = 5

export function caseWords(words: readonly string[], style: CaseStyle): string {
  const w = words.map((x) => x.toLowerCase()).filter(Boolean)
  const cap = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1)
  switch (style) {
    case 'camel':
      return w.map((x, i) => (i ? cap(x) : x)).join('')
    case 'pascal':
      return w.map(cap).join('')
    case 'snake':
      return w.join('_')
    case 'kebab':
      return w.join('-')
    case 'constant':
      return w.join('_').toUpperCase()
  }
}

function styleOf(spoken: string): CaseStyle {
  const s = spoken.toLowerCase()
  if (s.startsWith('screaming') || s.startsWith('upper') || s === 'constant') return 'constant'
  return s as CaseStyle
}

/** "camel case user name" → "userName"; the identifier ends at a stop word or punctuation. */
export function applyCaseCommands(text: string): string {
  // The rest after one identifier may hold the next command ("… to snake case …").
  let out = text
  for (let i = 0; i < 8; i++) {
    const next = caseOnce(out)
    if (next === out) break
    out = next
  }
  return out
}

function caseOnce(text: string): string {
  return text.replace(CASE_RE, (whole, spokenStyle: string, rest: string) => {
    const parts = rest.split(/(?=[ ,])/)
    const words: string[] = []
    let used = 0
    for (const part of parts) {
      const word = part.replace(/^[ ,]+/, '').trim()
      if (!word) break
      // A comma or full stop the cleanup put in ends the identifier.
      if (words.length && /^,/.test(part)) break
      if (words.length && STOP_WORDS.has(word.toLowerCase())) break
      if (words.length >= MAX_IDENT_WORDS) break
      words.push(word)
      used += part.length
    }
    if (!words.length) return whole
    const ident = caseWords(words, styleOf(spokenStyle))
    return ident + rest.slice(used)
  })
}

type Join = 'both' | 'next' | 'prev' | 'spaced'

// Longest phrases first. "both" glues to both neighbours, "next" to the word after,
// "prev" to the word before, "spaced" keeps one space on each side.
const SYMBOLS: [string, string, Join][] = [
  ['triple equals', '===', 'spaced'],
  ['double equals', '==', 'spaced'],
  ['not equals', '!=', 'spaced'],
  ['fat arrow', '=>', 'spaced'],
  ['plus equals', '+=', 'spaced'],
  ['minus equals', '-=', 'spaced'],
  ['open paren', '(', 'next'],
  ['open parenthesis', '(', 'next'],
  ['left paren', '(', 'next'],
  ['close paren', ')', 'prev'],
  ['close parenthesis', ')', 'prev'],
  ['right paren', ')', 'prev'],
  ['empty parens', '()', 'prev'],
  ['open bracket', '[', 'next'],
  ['open square bracket', '[', 'next'],
  ['close bracket', ']', 'prev'],
  ['close square bracket', ']', 'prev'],
  ['open brace', '{', 'spaced'],
  ['open curly brace', '{', 'spaced'],
  ['open curly', '{', 'spaced'],
  ['close brace', '}', 'spaced'],
  ['close curly brace', '}', 'spaced'],
  ['close curly', '}', 'spaced'],
  ['open angle', '<', 'next'],
  ['close angle', '>', 'prev'],
  ['less than', '<', 'spaced'],
  ['greater than', '>', 'spaced'],
  ['at sign', '@', 'next'],
  ['hash sign', '#', 'next'],
  ['dollar sign', '$', 'next'],
  ['percent sign', '%', 'prev'],
  ['double quote', '"', 'spaced'],
  ['single quote', "'", 'spaced'],
  ['back slash', '\\', 'both'],
  ['backslash', '\\', 'both'],
  ['forward slash', '/', 'both'],
  ['slash', '/', 'both'],
  ['underscore', '_', 'both'],
  ['backtick', '`', 'spaced'],
  ['back tick', '`', 'spaced'],
  ['ampersand', '&', 'spaced'],
  ['asterisk', '*', 'spaced'],
  ['tilde', '~', 'next'],
  ['caret', '^', 'spaced'],
  ['equals', '=', 'spaced'],
  ['dot', '.', 'both'],
  ['dash dash', '--', 'next'],
  ['semicolon', ';', 'prev']
]

const SORTED = [...SYMBOLS].sort((a, b) => b[0].length - a[0].length)

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SYMBOL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${SORTED.map(([p]) => p.split(' ').map(escapeRe).join('[ -]')).join('|')})(?![\\p{L}\\p{N}])`,
  'giu'
)
const BY_PHRASE = new Map(SORTED.map(([p, sym, join]) => [p, { sym, join }]))

/** Spoken symbols → characters with code spacing. "dot" only between two words. */
export function applySymbols(text: string): string {
  // Markers keep the joining rule until spaces are settled.
  const marked = text.replace(SYMBOL_RE, (m, offset: number, all: string) => {
    const key = m.toLowerCase().replace(/-/g, ' ')
    const hit = BY_PHRASE.get(key)
    if (!hit) return m
    if (key === 'dot') {
      // "dot" glues words ("config dot json"); at an edge it stays a word.
      const before = all.slice(0, offset).trimEnd()
      const after = all.slice(offset + m.length).trimStart()
      if (!/[\p{L}\p{N}_)\]]$/u.test(before) || !/^[\p{L}\p{N}_]/u.test(after)) return m
    }
    return `${hit.join}${hit.sym}`
  })
  if (marked === text) return text
  return marked.replace(
    /\s*(\w+)([^]*)\s*/gu,
    (m, join: Join, sym, off: number, all: string) => {
      const atStart = off === 0
      const atEnd = off + m.length === all.length
      const lead = /^\s/.test(m) && !atStart ? ' ' : ''
      const trail = /\s$/.test(m) && !atEnd ? ' ' : ''
      switch (join) {
        case 'both':
          return sym
        case 'next':
          return `${lead}${sym}`
        case 'prev':
          return `${sym}${trail}`
        case 'spaced':
          return `${atStart ? '' : ' '}${sym}${atEnd ? '' : ' '}`
      }
      return m
    }
  )
}

export type FileResolver = (name: string) => string | null

const FILE_TAG_RE = /\b(?:at|tag) file\s+(\S+)/giu

/** "at file pipeline.ts" → "@pipeline.ts", or "@src/main/…/pipeline.ts" when resolved. */
export function applyFileTags(text: string, resolve?: FileResolver): string {
  return text.replace(FILE_TAG_RE, (_m, raw: string) => {
    const tail = /[,.;:!?]+$/.exec(raw)?.[0] ?? ''
    const name = tail ? raw.slice(0, -tail.length) : raw
    const path = resolve?.(name) ?? name
    return `@${path}${tail}`
  })
}

export interface CodingOptions {
  resolveFile?: FileResolver
}

/** Everything coding mode does, in order: identifiers, symbols, file tags. */
export function applyCodingMode(text: string, opts: CodingOptions = {}): string {
  if (!text) return text
  let t = applyCaseCommands(text)
  t = applySymbols(t)
  t = applyFileTags(t, opts.resolveFile)
  return t
}
