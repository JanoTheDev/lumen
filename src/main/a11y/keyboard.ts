// Scan keyboard model (06 T10): QWERTY + number row + common keys + word suggestions from a
// local frequency list (no model calls). Pure: the window, scanning and typing are wired in
// install-switch.ts. Keys type through the agent `input` steps returned by press().
import type { InputStep } from '@shared/types'
import type { ScanKeyboardKey, ScanKeyboardState } from '@shared/channels'
import type { ScanItem, ScanLevel, ScanResult } from './switch'
import { WORDS } from './words'

export const SUGGESTIONS = 4

interface KeyDef {
  id: string
  label: string
  /** Spoken / scanned name when the label is a symbol. */
  name?: string
  wide?: number
}

const chars = (s: string): KeyDef[] => [...s].map((c) => ({ id: `c:${c}`, label: c }))

/** Rows after the suggestion row. */
const ROWS: KeyDef[][] = [
  [...chars('1234567890'), { id: 'backspace', label: '⌫', name: 'Backspace', wide: 2 }],
  chars('qwertyuiop'),
  [...chars("asdfghjkl'"), { id: 'enter', label: '⏎', name: 'Enter', wide: 2 }],
  [{ id: 'shift', label: '⇧', name: 'Shift', wide: 2 }, ...chars('zxcvbnm,.?')],
  [
    { id: 'space', label: 'Space', wide: 5 },
    { id: 'tab', label: 'Tab' },
    { id: 'caps', label: 'Caps' },
    { id: 'left', label: '←', name: 'Left' },
    { id: 'right', label: '→', name: 'Right' },
    { id: 'esc', label: 'Esc' },
    { id: 'close', label: 'Close', wide: 2 }
  ]
]

const NAMED: Record<string, string> = {
  ',': 'comma',
  '.': 'period',
  '?': 'question mark',
  "'": 'apostrophe'
}

const COMBO: Record<string, string> = {
  backspace: 'backspace',
  enter: 'enter',
  tab: 'tab',
  left: 'left',
  right: 'right',
  esc: 'esc'
}

const WORD_CHAR = /^[a-z']$/i

export interface KeyPress {
  steps: InputStep[]
  /** The Close key: hide the keyboard. */
  close?: boolean
}

/** Case of the suggestion follows what the user started typing. */
function matchCase(word: string, prefix: string): string {
  if (prefix.length > 1 && prefix === prefix.toUpperCase()) return word.toUpperCase()
  if (prefix[0] && prefix[0] !== prefix[0].toLowerCase())
    return word[0].toUpperCase() + word.slice(1)
  return word
}

/** Up to `max` words starting with `prefix`, the user's own words first, then by frequency. */
export function predict(
  prefix: string,
  learned: Map<string, number> = new Map(),
  max = SUGGESTIONS
): string[] {
  const p = prefix.toLowerCase()
  if (!p) return []
  const mine = [...learned.entries()]
    .filter(([w]) => w.startsWith(p) && w !== p)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
  const out: string[] = []
  for (const w of [...mine, ...WORDS]) {
    if (out.length >= max) break
    if (w !== p && w.startsWith(p) && !out.includes(w)) out.push(w)
  }
  return out.map((w) => matchCase(w, prefix))
}

export class ScanKeyboardModel {
  shift = false
  caps = false
  /** Letters of the word being typed (since the last space/punctuation). */
  word = ''
  private learned = new Map<string, number>()
  private highlight: ScanKeyboardState['highlight'] = { row: null, key: null }

  suggestions(): string[] {
    return predict(this.word, this.learned)
  }

  /** Every row, the suggestion row first (empty when nothing is typed). */
  rows(): ScanKeyboardKey[][] {
    const sugg: ScanKeyboardKey[] = this.suggestions().map((w, i) => ({
      id: `s:${i}`,
      label: w,
      wide: 3
    }))
    const rest = ROWS.map((row) =>
      row.map((k): ScanKeyboardKey => {
        const on = (k.id === 'shift' && this.shift) || (k.id === 'caps' && this.caps)
        const label = k.id.startsWith('c:') && this.upper() ? k.label.toUpperCase() : k.label
        return { id: k.id, label, name: k.name ?? NAMED[k.label], wide: k.wide, on }
      })
    )
    return [sugg, ...rest]
  }

  setHighlight(row: number | null, key: number | null): void {
    this.highlight = { row, key }
  }

  state(): ScanKeyboardState {
    return { rows: this.rows(), highlight: this.highlight, shift: this.shift, caps: this.caps }
  }

  private upper(): boolean {
    return this.shift !== this.caps
  }

  /** What a key does; unknown ids do nothing. */
  press(id: string): KeyPress {
    if (id === 'close') return { steps: [], close: true }
    if (id === 'shift') {
      this.shift = !this.shift
      return { steps: [] }
    }
    if (id === 'caps') {
      this.caps = !this.caps
      return { steps: [] }
    }
    if (id.startsWith('s:')) return this.suggest(Number(id.slice(2)))
    if (id === 'space') return this.type(' ')
    if (id.startsWith('c:')) return this.type(id.slice(2))
    const combo = COMBO[id]
    if (!combo) return { steps: [] }
    if (id === 'backspace') this.word = this.word.slice(0, -1)
    else this.endWord()
    return { steps: [{ t: 'keys', combo }] }
  }

  private type(ch: string): KeyPress {
    const text = this.upper() ? ch.toUpperCase() : ch
    this.shift = false
    if (WORD_CHAR.test(ch)) this.word += text
    else this.endWord()
    return { steps: [{ t: 'type', text }] }
  }

  private suggest(i: number): KeyPress {
    const word = this.suggestions()[i]
    if (!word) return { steps: [] }
    const rest = word.slice(this.word.length)
    this.learn(word)
    this.word = ''
    this.shift = false
    return { steps: [{ t: 'type', text: `${rest} ` }] }
  }

  private endWord(): void {
    if (this.word.length > 1) this.learn(this.word)
    this.word = ''
  }

  private learn(word: string): void {
    const w = word.toLowerCase()
    this.learned.set(w, (this.learned.get(w) ?? 0) + 1)
  }

  /** The keyboard opened again: forget the half-typed word (focus may be elsewhere now). */
  reset(): void {
    this.word = ''
    this.shift = false
    this.highlight = { row: null, key: null }
  }
}

/** Spoken name of a key for announcements. */
export function keyName(k: ScanKeyboardKey): string {
  return k.name ?? k.label
}

export interface KeyboardScanIo {
  /** Types the key; resolves once the agent is done. */
  press(id: string): Promise<void>
  close(): void
  /** The model changed (highlight, suggestions, shift): redraw the window. */
  render(): void
}

/**
 * Row/column scanning over the keyboard: rows first (suggestions on top), then the keys of
 * the picked row. After a key the scan goes back to the rows; Close (or Back from the rows)
 * hides the keyboard. Labels are getters so a row reads its current suggestions.
 */
export function keyboardScanLevel(kb: ScanKeyboardModel, io: KeyboardScanIo): ScanLevel {
  const rowItem = (r: number): ScanItem => ({
    get label() {
      const keys = kb.rows()[r]
      if (r === 0)
        return keys.length ? `Suggestions: ${keys.map(keyName).join(', ')}` : 'No suggestions'
      return `Row ${r}: ${keys.slice(0, 4).map(keyName).join(' ')}`
    },
    select: (): ScanResult => {
      const keys = kb.rows()[r]
      if (!keys.length) return 'stay'
      return { push: keyLevel(r) }
    }
  })
  const keyLevel = (r: number): ScanLevel => ({
    title: `Row ${r}`,
    external: true,
    items: kb.rows()[r].map((k) => ({
      label: keyName(k),
      select: async (): Promise<ScanResult> => {
        if (k.id === 'close') {
          io.close()
          return 'root'
        }
        await io.press(k.id)
        return 'back'
      }
    })),
    onHighlight: (i) => {
      kb.setHighlight(r, i)
      io.render()
    }
  })
  const rows = kb.rows().length
  return {
    title: 'Keyboard',
    external: true,
    items: Array.from({ length: rows }, (_, r) => rowItem(r)),
    onHighlight: (i) => {
      kb.setHighlight(i !== null && i < rows ? i : null, null)
      io.render()
    },
    onExit: () => io.close()
  }
}
