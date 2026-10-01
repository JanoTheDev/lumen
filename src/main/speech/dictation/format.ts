// Deterministic formatting of cleaned dictation (04 T35): spoken lists → numbered or bulleted
// lines, numbers / money / dates / times as digits, spoken emails and web addresses, and
// (when the model cleanup did not run) spoken line breaks and punctuation words. Runs after
// cleanup so the model keeps its rule against digits. Every result is checked against the
// cleaned text on canonical tokens; a formatting that lost or added a word is dropped.
import { tokenize } from './cleanup'
import { formatNumbers, numbersToDigits } from './numbers'
import type { FocusTarget } from './terminal-guard'

/** rich: Word / mail / docs editors; plain: multi-line text; single: a one-line field. */
export type FieldKind = 'rich' | 'plain' | 'single'

const RICH_PROCESSES = new Set([
  'winword.exe',
  'outlook.exe',
  'olk.exe',
  'onenote.exe',
  'notion.exe',
  'obsidian.exe',
  'thunderbird.exe',
  'slack.exe',
  'ms-teams.exe',
  'teams.exe'
])
const BROWSERS = new Set([
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'opera.exe',
  'vivaldi.exe',
  'arc.exe'
])
const RICH_TITLE = /\b(?:gmail|notion|google docs|docs|outlook|slack|confluence)\b/i

export function fieldKindOf(t: Pick<FocusTarget, 'process' | 'title' | 'role'>): FieldKind {
  const proc = t.process.toLowerCase()
  const role = t.role.toLowerCase()
  if (RICH_PROCESSES.has(proc) || role === 'document') return 'rich'
  if (BROWSERS.has(proc) && RICH_TITLE.test(t.title)) return 'rich'
  if (role === 'edit' || role === 'combobox') return 'single'
  return 'plain'
}

export interface FormatOptions {
  kind: FieldKind
  /** The model cleanup did not run: spoken "new line", "comma", … are still words. */
  spokenCommands?: boolean
}

// ---- Spoken line breaks and punctuation (only when the model did not apply them) ----

const BREAKS: [RegExp, string][] = [
  [/[\s,.;:]*\bnew paragraph\b[\s,.;:]*/gi, '\n\n'],
  [/[\s,.;:]*\b(?:new|next) line\b[\s,.;:]*/gi, '\n']
]
// Not after a word that makes it a noun ("the period", "a colon").
const NOT_AFTER = '(?<!\\b(?:a|an|the|this|that|per|each|my|your|its)\\s)'
const PUNCT: [RegExp, string][] = [
  [/\s*\bquestion mark\b/gi, '?'],
  [/\s*\bexclamation (?:mark|point)\b/gi, '!'],
  [/\s*\bfull stop\b/gi, '.'],
  [new RegExp(`(?<=\\w)${NOT_AFTER}\\s+(?:period)\\b`, 'gi'), '.'],
  [new RegExp(`(?<=\\w)${NOT_AFTER}\\s+(?:comma)\\b`, 'gi'), ','],
  [new RegExp(`(?<=\\w)${NOT_AFTER}\\s+(?:semicolon)\\b`, 'gi'), ';'],
  [new RegExp(`(?<=\\w)${NOT_AFTER}\\s+(?:colon)\\b`, 'gi'), ':']
]

export function applySpokenCommands(text: string): string {
  let t = text
  for (const [re, to] of BREAKS) t = t.replace(re, to)
  for (const [re, to] of PUNCT) t = t.replace(re, to)
  // Capital after a sentence end or a line break the commands made.
  return t.replace(/([.!?]\s+|\n)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
}

// ---- Emails and web addresses ----

const TLD = 'com|org|net|io|ai|co|dev|app|edu|gov|uk|de|nl|fr|es|eu|me|info|us|ca'
const LABEL = '[a-z0-9][a-z0-9_-]*'
const DOMAIN = `${LABEL}(?:\\s+dot\\s+${LABEL})*\\s+dot\\s+(?:${TLD})\\b`
const EMAIL_RE = new RegExp(`\\b(${LABEL}(?:\\s+dot\\s+${LABEL})*)\\s+at\\s+(${DOMAIN})`, 'gi')
const URL_RE = new RegExp(
  `\\b(?!(?:the|a|an|this|that)\\s)((?:w\\s?w\\s?w\\s+dot\\s+)?${DOMAIN}(?:\\s+slash\\s+${LABEL})*)`,
  'gi'
)

const joinDots = (s: string): string =>
  s
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+slash\s+/gi, '/')
    .replace(/^w\s?w\s?w\./i, 'www.')
    .toLowerCase()

/**
 * Words that put "at" in a sentence, not in an address: "find us at lumen dot app" is a
 * place to visit, not the mailbox "us". An address with one of them before "at" stays words.
 */
const PROSE_BEFORE_AT = new Set(
  (
    'us me you him her them it we they everyone anyone someone out in on up off back home ' +
    'work school here there now today tonight tomorrow online live available look looking ' +
    'meet see find reach call contact visit stay arrive arrived be is are was were all one'
  ).split(' ')
)

const proseLocal = (user: string): boolean =>
  user
    .toLowerCase()
    .split(/\s+dot\s+/)
    .some((w) => PROSE_BEFORE_AT.has(w))

export function formatAddresses(text: string): string {
  return text
    .replace(EMAIL_RE, (m: string, user: string, domain: string) =>
      proseLocal(user) ? m : `${joinDots(user)}@${joinDots(domain)}`
    )
    .replace(URL_RE, (m: string) => joinDots(m))
}

// ---- Lists ----

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth'
]
const CARDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const ORDINAL_RE = new RegExp(
  `(^|[.:;,!?]\\s+|\\n\\s*)(?:(${ORDINALS.join('|')})(?:ly)?|number\\s+(${CARDINALS.join('|')}))\\b[,:]?\\s*`,
  'gi'
)
const BULLET_RE = /(^|[.:;,!?]?\s+|\n\s*)(?:bullet point|next bullet|new bullet)\b[,:]?\s*/gi

interface Marker {
  at: number
  end: number
}

function ordinalMarkers(text: string): Marker[] {
  const out: Marker[] = []
  for (const m of text.matchAll(ORDINAL_RE)) {
    const word = (m[2] ?? m[3]).toLowerCase()
    const n = m[2] ? ORDINALS.indexOf(word) + 1 : CARDINALS.indexOf(word) + 1
    const marker = { at: m.index + m[1].length, end: m.index + m[0].length }
    // Markers count 1, 2, 3 … ; a new "first" before a list formed starts over.
    if (n === out.length + 1) out.push(marker)
    else if (n === 1 && out.length < 2) out.splice(0, out.length, marker)
  }
  return out.length >= 2 ? out : []
}

function bulletMarkers(text: string): Marker[] {
  return [...text.matchAll(BULLET_RE)].map((m) => ({
    at: m.index + m[1].length,
    end: m.index + m[0].length
  }))
}

const trimItem = (s: string): string => s.replace(/^[\s,;:.]+|[\s,;:]+$/g, '').replace(/\.$/, '')
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** Spoken list markers turned into lines ("1. …" / "- …"), or one line for a one-line field. */
export function formatLists(text: string, kind: FieldKind): string {
  let markers = ordinalMarkers(text)
  let numbered = true
  if (!markers.length) {
    markers = bulletMarkers(text)
    numbered = false
  }
  if (!markers.length) return text
  const intro = text
    .slice(0, markers[0].at)
    .replace(/[\s,;:.]+$/, '')
    .trim()
  const items: string[] = []
  let rest = ''
  for (let i = 0; i < markers.length; i++) {
    let item = text.slice(markers[i].end, markers[i + 1]?.at ?? text.length)
    if (i === markers.length - 1) {
      // Text after the last item's sentence is not part of the list.
      const m = /[.!?](?=\s+\S)/.exec(item)
      if (m) {
        rest = item.slice(m.index + 1).trim()
        item = item.slice(0, m.index)
      }
    }
    items.push(cap(trimItem(item)))
  }
  if (items.some((it) => !it)) return text
  const head = intro ? `${intro}:` : ''
  if (kind === 'single') {
    const line = items.join(', ')
    return [head, line].filter(Boolean).join(' ') + (rest ? ` ${rest}` : '')
  }
  const lines = items.map((it, i) => (numbered ? `${i + 1}. ${it}` : `- ${it}`))
  return [head, ...lines, rest].filter(Boolean).join('\n')
}

// ---- Check and entry point ----

const DROPPED_PHRASES =
  /\b(?:new paragraph|new line|next line|question mark|exclamation mark|exclamation point|full stop|period|comma|semicolon|colon|bullet point|next bullet|new bullet|dot|at|slash|number|dollars?|bucks|euros?|pounds?|percent)\b/gi

/** The tokens formatting must keep: words, with numbers as digits and spoken syntax removed. */
export function canonicalTokens(text: string): string[] {
  const t = text
    // "us@lumen.app" from "us at lumen dot app" is a changed sentence, not an address.
    .replace(/([\p{L}\p{N}]+)@/gu, (m: string, w: string) =>
      PROSE_BEFORE_AT.has(w.toLowerCase()) ? `${w} atsign ` : m
    )
    .replace(DROPPED_PHRASES, ' ')
    .replace(/\bw\s?w\s?w\b/gi, 'www')
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)ly\b/gi, '$1')
  return tokenize(numbersToDigits(t))
}

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((w, i) => w === b[i])

function tidy(text: string, kind: FieldKind): string {
  let t = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (kind === 'single') t = t.replace(/\s*\n+\s*/g, ' ')
  return t
}

/** Formats cleaned dictation for the field it goes into. Never changes the words. */
export function formatDictation(text: string, opts: FormatOptions): string {
  let t = text
  if (opts.spokenCommands) t = applySpokenCommands(t)
  t = formatAddresses(t)
  t = formatNumbers(t)
  t = formatLists(t, opts.kind)
  t = tidy(t, opts.kind)
  if (!same(canonicalTokens(text), canonicalTokens(t))) {
    console.warn('[dictation] formatting changed words; typing the cleaned text')
    return tidy(text, opts.kind)
  }
  return t
}
