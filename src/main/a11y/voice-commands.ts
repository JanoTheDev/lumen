// Local voice-control grammar (06 T01): a table-driven, anchored matcher that runs before any
// LLM. Pure: no Electron imports. The dispatcher (dispatch.ts) executes what this returns.
import { GRAMMAR, SHEET_EXTRAS, type Category, type Gate, type GrammarEntry } from './grammar/en'
import { parseKeys } from './grammar/keys'
import { NUMBER_SLOT, parseNumber } from './grammar/numbers'

export type { Category, Gate, GrammarEntry }

export interface CommandContext {
  marksShown: boolean
  gridShown: boolean
  /** A grid drag start is set and waits for "drop". */
  dragStarted: boolean
  guideActive: boolean
  autoScrolling: boolean
  /** An answer card is on screen (pin, dismiss). */
  answerShown?: boolean
  /** "Read the page" is reading or paused. */
  reading?: boolean
  /** A screen description was given a moment ago ("more detail"). */
  described?: boolean
  /** A lesson is running (its words come first). */
  lessonActive?: boolean
}

export const IDLE_CONTEXT: CommandContext = {
  marksShown: false,
  gridShown: false,
  dragStarted: false,
  guideActive: false,
  autoScrolling: false
}

export type ArgValue = string | number | boolean
export type CommandArgs = Record<string, ArgValue>

export interface Command {
  id: string
  args: CommandArgs
  /** 1 = fixed phrase, 0.9 = slot pattern, 0.8 = a number heard as a homophone ("click to"). */
  confidence: number
  category: Category
}

// ---- Normalization ----

const FILLERS =
  'please|can you|could you|would you|will you|hey lumen|lumen|hey|uh+|um+|er|okay|ok|alright|so|now'
const LEADING_FILLER = new RegExp(`^(?:${FILLERS})(?:[,\\s]+|$)`, 'i')
const TRAILING_FILLER = /[,\s]+(?:please|thanks|thank you|now)$/i

function stripFillers(text: string): string {
  let t = text
  for (let i = 0; i < 6; i++) {
    const next = t.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim()
    if (next === t) break
    t = next
  }
  return t
}

/** Lowercase, apostrophes dropped, hyphens and punctuation to spaces, fillers removed. */
export function normalize(utterance: string): string {
  const t = utterance
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripFillers(t)
}

/** The utterance with case and inner punctuation kept, for free-text slots. */
function lightNormalize(utterance: string): string {
  const t = utterance
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.!?;:\s]+/, '')
    .replace(/[.!?]+$/, '')
  return stripFillers(t).replace(/^[,\s]+|[,\s]+$/g, '')
}

// ---- Compilation ----

const SLOT: Record<string, string> = {
  n: `(?<n>${NUMBER_SLOT})`,
  m: `(?<m>${NUMBER_SLOT})`,
  dir: '(?<dir>up|down|left|right)',
  text: '(?<text>.+?)',
  app: '(?<app>.+)',
  keys: '(?<keys>.+?)',
  role: '(?<role>links?|buttons?|fields?|text fields?|text boxes|boxes|menus?|menu items|tabs?|checkboxes)',
  amount: '(?<amount>a little bit|a little|a bit|a lot|lots)'
}

function compilePattern(pattern: string, flags = ''): RegExp {
  let src = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '<') {
      const end = pattern.indexOf('>', i)
      const name = pattern.slice(i + 1, end)
      if (!SLOT[name]) throw new Error(`unknown slot <${name}> in "${pattern}"`)
      src += SLOT[name]
      i = end
    } else if (c === '[') src += '(?:'
    else if (c === ']') src += ')?'
    else if (c === '(' && pattern[i + 1] !== '?') src += '(?:'
    else src += c
  }
  return new RegExp(`^${src}$`, flags)
}

interface Compiled {
  entry: GrammarEntry
  normal: RegExp[]
  /** Case-insensitive variants run on the lightly normalized text for <text> slots. */
  light: RegExp[] | null
  fixed: boolean
}

const COMPILED: Compiled[] = GRAMMAR.map((entry) => {
  const hasText = entry.patterns.some((p) => p.includes('<text>'))
  return {
    entry,
    normal: entry.patterns.map((p) => compilePattern(p)),
    light: hasText ? entry.patterns.map((p) => compilePattern(p, 'i')) : null,
    fixed: !entry.patterns.some((p) => p.includes('<'))
  }
})

// ---- Slot validation ----

function gateHolds(gate: Gate | undefined, ctx: CommandContext): boolean {
  switch (gate) {
    case undefined:
      return true
    case 'marks':
      return ctx.marksShown
    case 'grid':
      return ctx.gridShown
    case 'grid-drag':
      return ctx.gridShown && ctx.dragStarted
    case 'no-guide':
      return !ctx.guideActive
    case 'autoscroll':
      return ctx.autoScrolling
    case 'answer':
      return !!ctx.answerShown
    case 'guide':
      return ctx.guideActive
    case 'reading':
      return !!ctx.reading
    case 'described':
      return !!ctx.described
    case 'lesson':
      return !!ctx.lessonActive
    case 'busy-target':
      return false
  }
}

const MULTI_CLAUSE = /\b(and|then|after that|also)\b/
const APP_STOPWORDS = /\b(the|a|an|my|this|that|first|second|third|last|next|new|some|it)\b/
const ROLE_OF: Record<string, string> = {
  link: 'links',
  button: 'buttons',
  field: 'fields',
  'text field': 'fields',
  'text boxe': 'fields',
  boxe: 'fields',
  menu: 'menus',
  'menu item': 'menus',
  tab: 'tabs',
  checkboxe: 'checkboxes'
}

const AMOUNT: Record<string, 'little' | 'lot'> = {
  'a little bit': 'little',
  'a little': 'little',
  'a bit': 'little',
  'a lot': 'lot',
  lots: 'lot'
}

/** Slot groups → args; null when a slot value is not acceptable here. */
function slotArgs(
  id: string,
  groups: Record<string, string | undefined>,
  ctx: CommandContext
): { args: CommandArgs; homophone: boolean } | null {
  const args: CommandArgs = {}
  let homophone = false
  for (const key of ['n', 'm'] as const) {
    const raw = groups[key]
    if (raw === undefined) continue
    const num = parseNumber(raw.toLowerCase())
    if (!num) return null
    // "click to" is "click 2" only while numbers or the grid are on screen.
    if (num.homophone && !ctx.marksShown && !ctx.gridShown) return null
    homophone ||= num.homophone
    args[key] = num.value
  }
  if (groups.dir) args.dir = groups.dir
  if (groups.amount) args.amount = AMOUNT[groups.amount] ?? 'normal'
  if (groups.role) {
    const r = groups.role.replace(/s$/, '')
    args.role = ROLE_OF[r] ?? (r.endsWith('s') ? r : `${r}s`)
  }
  if (groups.keys !== undefined) {
    const keys = parseKeys(groups.keys)
    if (!keys) return null
    args.combo = keys.join('+')
  }
  if (groups.text !== undefined) {
    const text = groups.text.trim()
    if (!text) return null
    args.text = text
  }
  if (groups.app !== undefined) {
    const app = groups.app.trim()
    const words = app.split(/\s+/)
    if (!app || words.length > 4 || MULTI_CLAUSE.test(app) || APP_STOPWORDS.test(app)) return null
    if (/^\d+$/.test(app)) return null
    args.app = app
  }
  // Per-command ranges.
  const n = args.n as number | undefined
  if (n !== undefined) {
    if (id === 'grid.select' && (n < 1 || n > 9)) return null
    if (id === 'grid.show' && (n < 1 || n > 9)) return null
    if (id === 'tab.n' && (n < 1 || n > 9)) return null
    if (id.startsWith('marks.') && n < 1) return null
    if ((id === 'scroll' || id === 'key.press' || id === 'key.fixed') && (n < 1 || n > 50))
      return null
    if (id === 'pointer.move' && (n < 1 || n > 100)) return null
  }
  return { args, homophone }
}

// ---- Matching ----

const WRITE_INTENT = /^(a|an|the|me|my|to|back|up|down|some|about)\b/i

/** Free-text commands that read like a request for the assistant fall through to the router. */
function plausible(id: string, norm: string, args: CommandArgs): boolean {
  const text = typeof args.text === 'string' ? args.text : ''
  if (id === 'key.type' && norm.startsWith('write ') && WRITE_INTENT.test(text)) return false
  if (id === 'pointer.click-name') {
    if (parseNumber(text.toLowerCase()) || MULTI_CLAUSE.test(text.toLowerCase())) return false
    if (text.split(/\s+/).length > 5) return false
  }
  return true
}

const MAX_CHARS = 200

/**
 * The command for one complete utterance in command context, or null (→ LLM router).
 * Anchored and table ordered: exact phrases and slot patterns, first match wins.
 */
export function parseCommand(
  utterance: string,
  ctx: CommandContext = IDLE_CONTEXT
): Command | null {
  if (!utterance || utterance.length > MAX_CHARS) return null
  const norm = normalize(utterance)
  if (!norm) return null
  const light = lightNormalize(utterance)
  for (const c of COMPILED) {
    if (!gateHolds(c.entry.gate, ctx)) continue
    const candidates: [RegExp[], string][] = c.light
      ? [
          [c.light, light],
          [c.normal, norm]
        ]
      : [[c.normal, norm]]
    for (const [regexes, text] of candidates) {
      for (const re of regexes) {
        const m = re.exec(text)
        if (!m) continue
        const slots = slotArgs(c.entry.id, m.groups ?? {}, ctx)
        if (!slots || !plausible(c.entry.id, norm, slots.args)) continue
        return {
          id: c.entry.id,
          args: { ...c.entry.args, ...slots.args },
          confidence: slots.homophone ? 0.8 : c.fixed ? 1 : 0.9,
          category: c.entry.category
        }
      }
    }
  }
  return null
}

/** Help sheet rows (T21), filtered to what applies in `ctx`. One row per distinct phrase. */
export function commandSheet(
  ctx?: CommandContext
): { category: Category; say: string; does: string }[] {
  const seen = new Set<string>()
  const out: { category: Category; say: string; does: string }[] = []
  for (const e of GRAMMAR) {
    if (ctx && !gateHolds(e.gate, ctx)) continue
    if (seen.has(e.say)) continue
    seen.add(e.say)
    out.push({ category: e.category, say: e.say, does: e.does })
  }
  return out
}

/** When a gated command applies, in words for the help sheet. */
export const GATE_WHEN: Record<Gate, string> = {
  marks: 'while numbers are shown',
  grid: 'while the grid is shown',
  'grid-drag': 'after "drag" in the grid',
  // Ordinary commands that a running guide takes over ("back"); not worth a note.
  'no-guide': '',
  autoscroll: 'while scrolling',
  'busy-target': 'while Lumen is busy',
  answer: 'while an answer is shown',
  guide: 'during a guide',
  reading: 'while Lumen reads aloud',
  described: 'right after a description',
  lesson: 'during a lesson'
}

export interface SheetRow {
  category: Category
  say: string
  does: string
  when?: string
  /** Applies in `ctx` right now. */
  now: boolean
}

/**
 * Every command for the "what can I say" sheet (T21), generated from the grammar table so the
 * sheet never drifts from what is matched. One row per phrase and gate.
 */
export function commandSheetRows(
  ctx: CommandContext,
  extra: readonly GrammarEntry[] = []
): SheetRow[] {
  const seen = new Set<string>()
  const out: SheetRow[] = []
  for (const e of [...GRAMMAR, ...SHEET_EXTRAS, ...extra]) {
    const key = `${e.say}|${e.gate ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      category: e.category,
      say: e.say,
      does: e.does,
      ...(e.gate && GATE_WHEN[e.gate] ? { when: GATE_WHEN[e.gate] } : {}),
      now: gateHolds(e.gate, ctx)
    })
  }
  return out
}
