// Captions and transcript confirmation (06 T14), pure parts: correction commands, spelling,
// yes/no answers to a pending confirm, which actions are risky enough to ask about, and the
// personal vocabulary learned from corrections. No Electron imports.
//
//   "no, I said <text>"  replaces the last utterance and runs <text>
//   "correct that"       opens the caption for editing (keyboard or a new dictation)
//   "spell that"         opens it for letter-by-letter spelling (NATO words work too)
// While the caption is open: "done" runs it, "cancel" closes it, "clear" empties it.

export type EditMode = 'edit' | 'spell'

export interface CaptionEdit {
  mode: EditMode
  draft: string
}

export type CaptionStep =
  /** Run this text as the user's utterance (a correction or a finished edit). */
  | { type: 'rerun'; text: string }
  /** The caption editor opened or its draft changed. */
  | { type: 'draft'; edit: CaptionEdit }
  /** The editor closed without running anything. */
  | { type: 'close' }

/** Lowercase words only, for matching short commands. */
export function plainWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

const REPLACE_RE = /^\s*no\b[\s,.!:;-]*i\s+(?:said|meant)\b[\s,.:;-]*(.+?)[\s.!]*$/i
const EDIT_RE = /^(please )?(correct|fix|edit|change) (that|it|what you heard)$/
const SPELL_RE = /^(please )?(spell (that|it)|let me spell( it| that)?)$/
const DONE_RE = /^(done|ok|okay|go|go ahead|run it|run that|send it|thats it|submit|finished)$/
const CANCEL_RE = /^(cancel|never ?mind|stop|close|forget it)$/
const CLEAR_RE = /^(clear|clear (it|that)|start over)$/

export type Correction = { type: 'replace'; text: string } | { type: 'open'; mode: EditMode }

/** A correction command, or null for an ordinary utterance. */
export function parseCorrection(utterance: string): Correction | null {
  const replace = REPLACE_RE.exec(utterance)
  if (replace && replace[1].trim()) return { type: 'replace', text: replace[1].trim() }
  const words = plainWords(utterance)
  if (EDIT_RE.test(words)) return { type: 'open', mode: 'edit' }
  if (SPELL_RE.test(words)) return { type: 'open', mode: 'spell' }
  return null
}

const YES_RE =
  /^(yes|yeah|yep|yup|ok|okay|sure|confirm|do it|go|go ahead|yes do it|yes please|please do|continue)$/
const NO_RE = /^(no|nope|nah|stop|cancel|dont|do not|deny|no thanks|never ?mind|dont do it)$/

/** "yes" / "no" while a confirm waits; null for anything else (a new request). */
export function confirmAnswer(utterance: string): 'yes' | 'no' | null {
  const w = plainWords(utterance)
  if (YES_RE.test(w)) return 'yes'
  if (NO_RE.test(w)) return 'no'
  return null
}

const NATO: Record<string, string> = {
  alpha: 'a',
  alfa: 'a',
  bravo: 'b',
  charlie: 'c',
  delta: 'd',
  echo: 'e',
  foxtrot: 'f',
  golf: 'g',
  hotel: 'h',
  india: 'i',
  juliet: 'j',
  juliett: 'j',
  kilo: 'k',
  lima: 'l',
  mike: 'm',
  november: 'n',
  oscar: 'o',
  papa: 'p',
  quebec: 'q',
  romeo: 'r',
  sierra: 's',
  tango: 't',
  uniform: 'u',
  victor: 'v',
  whiskey: 'w',
  whisky: 'w',
  xray: 'x',
  yankee: 'y',
  zulu: 'z'
}

const DIGITS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9'
}

const SYMBOLS: Record<string, string> = {
  space: ' ',
  dash: '-',
  hyphen: '-',
  dot: '.',
  period: '.',
  underscore: '_',
  at: '@',
  comma: ','
}

/**
 * Applies one spelled utterance to the draft: letters ("h e l l o", "H-E-L-L-O", "hotel
 * echo"), digits, "space", "dash", "capital h", "backspace". A whole word Whisper already
 * joined ("HELLO") is taken as written.
 */
export function applySpelling(draft: string, utterance: string): string {
  const tokens = utterance
    .replace(/x-ray/gi, 'xray')
    .split(/[\s,.;:!?-]+/)
    .filter(Boolean)
  let out = draft
  let capital = false
  for (const raw of tokens) {
    const t = raw.toLowerCase()
    if (t === 'capital' || t === 'uppercase' || t === 'upper') {
      capital = true
      continue
    }
    if (t === 'backspace' || t === 'delete') {
      out = out.slice(0, -1)
      continue
    }
    let piece: string
    if (t.length === 1) piece = t
    else if (NATO[t]) piece = NATO[t]
    else if (DIGITS[t]) piece = DIGITS[t]
    else if (SYMBOLS[t]) piece = SYMBOLS[t]
    else piece = raw
    out += capital ? piece.charAt(0).toUpperCase() + piece.slice(1) : piece
    capital = false
  }
  return out.slice(0, 4000)
}

/**
 * The correction state of the caption: the last utterance that ran and the open editor.
 * `handle` sees every utterance before the router; null means it is not a correction.
 */
export class CaptionSession {
  private last: string | null = null
  private open: CaptionEdit | null = null

  /** An utterance went to the assistant (it is what "no, I said" replaces). */
  heard(text: string): void {
    this.last = text
  }

  lastHeard(): string | null {
    return this.last
  }

  editing(): CaptionEdit | null {
    return this.open
  }

  /** Opens the editor on the last utterance (spelling starts empty). */
  startEdit(mode: EditMode): CaptionEdit {
    this.open = { mode, draft: mode === 'spell' ? '' : (this.last ?? '') }
    return this.open
  }

  cancelEdit(): void {
    this.open = null
  }

  /** The editor was submitted with `text` (typed): closes it, returns the text to run. */
  submit(text: string): string | null {
    this.open = null
    const t = text.trim()
    return t || null
  }

  handle(utterance: string): CaptionStep | null {
    if (this.open) return this.whileEditing(utterance, this.open)
    const c = parseCorrection(utterance)
    if (!c) return null
    if (c.type === 'replace') return { type: 'rerun', text: c.text }
    return { type: 'draft', edit: this.startEdit(c.mode) }
  }

  private whileEditing(utterance: string, edit: CaptionEdit): CaptionStep {
    const words = plainWords(utterance)
    if (DONE_RE.test(words)) {
      const text = this.submit(edit.draft)
      return text ? { type: 'rerun', text } : { type: 'close' }
    }
    if (CANCEL_RE.test(words)) {
      this.open = null
      return { type: 'close' }
    }
    if (CLEAR_RE.test(words)) return this.setDraft({ ...edit, draft: '' })
    const c = parseCorrection(utterance)
    if (c?.type === 'replace') {
      this.open = null
      return { type: 'rerun', text: c.text }
    }
    if (c?.type === 'open') return this.setDraft({ mode: c.mode, draft: edit.draft })
    if (edit.mode === 'spell')
      return this.setDraft({ ...edit, draft: applySpelling(edit.draft, utterance) })
    // A new dictation replaces the draft; "done" (or Enter) runs it.
    return this.setDraft({ ...edit, draft: utterance.trim() })
  }

  private setDraft(edit: CaptionEdit): CaptionStep {
    this.open = edit
    return { type: 'draft', edit }
  }
}

// ---- Confirmation policy ----

export type TranscriptPolicy = 'always' | 'risky' | 'off'
export type ActionRisk = 'low' | 'medium' | 'high'

/** The action fields the risk check reads (model actions as the renderer sends them). */
export interface RiskAction {
  type: string
  keys?: string[] | string
  text?: string
  url?: string
  description?: string
  target?: { kind?: string; text?: string }
}

/** Words on a control that make clicking it hard to undo. */
const RISKY_LABEL_RE =
  /\b(send|delete|remove|erase|discard|buy|pay|purchase|order|checkout|submit|post|publish|transfer|sign ?out|log ?out|uninstall|format|empty (the )?(trash|recycle bin)|close without saving|don'?t save|reply all|forward)\b/i

const RISKY_KEYS = new Set([
  'enter',
  'return',
  'delete',
  'shift+delete',
  'ctrl+enter',
  'ctrl+w',
  'ctrl+shift+w',
  'alt+f4',
  'ctrl+shift+esc',
  'ctrl+shift+delete'
])

/** Reversible but not nothing: typing, navigating, raw input. */
const MEDIUM = new Set(['type', 'open_url', 'navigate_url', 'input', 'uia_act'])

function combo(keys: string[] | string | undefined): string {
  const list = Array.isArray(keys) ? keys : (keys ?? '').split('+')
  return list
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .join('+')
}

function clickLabel(a: RiskAction): string {
  return [a.text, a.description, a.target?.text].filter(Boolean).join(' ')
}

/** How hard a batch is to undo: high = sends, deletes, closes or pays. */
export function actionRisk(actions: readonly RiskAction[]): ActionRisk {
  let risk: ActionRisk = 'low'
  for (const a of actions) {
    if (a.type === 'hotkey') {
      if (RISKY_KEYS.has(combo(a.keys))) return 'high'
    } else if (a.type.startsWith('click')) {
      if (RISKY_LABEL_RE.test(clickLabel(a))) return 'high'
    } else if (MEDIUM.has(a.type)) {
      risk = 'medium'
    }
  }
  return risk
}

/** Action kinds whose real risk depends on the focused window (password field, terminal). */
const WINDOW_RISK = new Set(['type', 'input', 'uia_act', 'text_insert'])

/**
 * Whether a yes on the transcript card can stand in for the safety gate's own confirm: the
 * card listed every action (describeActions shows 3), and none of them is one whose high
 * reason only shows up with the window (typing into a terminal or a password field).
 */
export function cardCoversBatch(actions: readonly RiskAction[]): boolean {
  return actions.length <= 3 && !actions.some((a) => WINDOW_RISK.has(a.type))
}

/** Whether a batch waits for an explicit yes before it runs. */
export function needsTranscriptConfirm(policy: TranscriptPolicy, risk: ActionRisk): boolean {
  if (policy === 'always') return true
  if (policy === 'risky') return risk === 'high'
  return false
}

function quote(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`
}

/** One short line for what a batch will do: "Type “hi”, then press Enter". */
export function describeActions(actions: readonly RiskAction[]): string {
  const parts = actions.slice(0, 3).map((a) => {
    if (a.type === 'type') return `type ${quote(a.text ?? '')}`
    if (a.type === 'hotkey')
      return `press ${combo(a.keys)
        .split('+')
        .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
        .join('+')}`
    if (a.type === 'open_url' || a.type === 'navigate_url') return `open ${a.url ?? 'a page'}`
    if (a.type.startsWith('click')) {
      const label = clickLabel(a)
      return label ? `click ${quote(label, 40)}` : 'click'
    }
    if (a.type.startsWith('scroll')) return 'scroll'
    return a.type.replace(/_/g, ' ')
  })
  if (actions.length > 3) parts.push(`${actions.length - 3} more`)
  const line = parts.join(', then ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

// ---- Personal vocabulary ----

const STOP_WORDS = new Set(
  'the and for you that this with what have are was not but can open click type press show find from into your about there their then them when where which would could should'.split(
    ' '
  )
)

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
}

/**
 * Counts words a correction brought in that the transcript did not have. A word corrected
 * twice joins the personal vocabulary (Whisper's prompt), so it is heard right next time.
 */
export class VocabLearner {
  private counts = new Map<string, number>()

  constructor(private readonly threshold = 2) {}

  /** Words that just reached the threshold (each returned once). */
  note(heard: string, corrected: string): string[] {
    const before = new Set(words(heard).map((w) => w.toLowerCase()))
    const learned: string[] = []
    const seen = new Set<string>()
    for (const w of words(corrected)) {
      const key = w.toLowerCase()
      if (key.length < 3 || before.has(key) || STOP_WORDS.has(key) || seen.has(key)) continue
      if (/^\d+$/.test(key)) continue
      seen.add(key)
      const n = (this.counts.get(key) ?? 0) + 1
      this.counts.set(key, n)
      if (n === this.threshold) learned.push(w)
    }
    return learned
  }
}

/** Adds words to the comma-separated `voiceVocab`, skipping ones already there. */
export function mergeVocab(vocab: string, add: readonly string[], maxChars = 2000): string {
  const list = vocab
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const have = new Set(list.map((s) => s.toLowerCase()))
  for (const w of add) {
    if (have.has(w.toLowerCase())) continue
    const next = [...list, w].join(', ')
    if (next.length > maxChars) break
    list.push(w)
    have.add(w.toLowerCase())
  }
  return list.join(', ')
}
