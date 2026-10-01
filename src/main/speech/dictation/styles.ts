// Dictation styles per app (04 T36). A style only changes capitals and end punctuation,
// never words: formal (mail, docs), casual (chat: no full stop after a one-line message),
// very casual (lowercase sentence starts too), code (no forced capital, no full stop).
// The kind of app comes from the focused process, else the browser tab title; the user can
// put any process or site word into a kind and pick the style of each kind in Settings.
import {
  DICTATION_STYLE_DEFAULTS,
  type DictationAppKind,
  type DictationStyle
} from '@shared/config'
import type { FocusTarget } from './terminal-guard'
import { isTerminalTarget } from './terminal-guard'

const PROCESS_KINDS: Record<string, DictationAppKind> = {
  'outlook.exe': 'email',
  'olk.exe': 'email',
  'thunderbird.exe': 'email',
  'mailbird.exe': 'email',
  'hxoutlook.exe': 'email',
  'slack.exe': 'work',
  'teams.exe': 'work',
  'ms-teams.exe': 'work',
  'zoom.exe': 'work',
  'discord.exe': 'personal',
  'whatsapp.exe': 'personal',
  'whatsapp.root.exe': 'personal',
  'telegram.exe': 'personal',
  'signal.exe': 'personal',
  'messenger.exe': 'personal',
  'winword.exe': 'docs',
  'onenote.exe': 'docs',
  'notion.exe': 'docs',
  'obsidian.exe': 'docs',
  'notepad.exe': 'docs',
  'wordpad.exe': 'docs',
  'code.exe': 'code',
  'code - insiders.exe': 'code',
  'cursor.exe': 'code',
  'windsurf.exe': 'code',
  'devenv.exe': 'code',
  'idea64.exe': 'code',
  'pycharm64.exe': 'code',
  'webstorm64.exe': 'code',
  'rider64.exe': 'code',
  'clion64.exe': 'code',
  'goland64.exe': 'code',
  'sublime_text.exe': 'code',
  'notepad++.exe': 'code',
  'zed.exe': 'code'
}

const TITLE_KINDS: [RegExp, DictationAppKind][] = [
  [/\b(?:gmail|outlook|proton ?mail|yahoo mail|fastmail)\b/i, 'email'],
  [/\b(?:slack|microsoft teams|linear|jira)\b/i, 'work'],
  [/\b(?:whatsapp|messenger|telegram|discord|instagram)\b/i, 'personal'],
  [/\b(?:google docs|notion|confluence|word)\b/i, 'docs'],
  [/\b(?:github|gitlab|codesandbox|replit|stack ?blitz)\b/i, 'code']
]

/** A code editor or IDE by its process (never by a window title). */
export function isCodeProcess(proc: string): boolean {
  return PROCESS_KINDS[proc.trim().toLowerCase()] === 'code'
}

/** The kind of app dictation is typing into; the user's own mapping wins. */
export function appKindOf(
  target: Pick<FocusTarget, 'process' | 'title' | 'name'>,
  userApps: Readonly<Record<string, DictationAppKind>> = {}
): DictationAppKind {
  const proc = target.process.toLowerCase()
  const title = target.title.toLowerCase()
  for (const [key, kind] of Object.entries(userApps)) {
    const k = key.trim().toLowerCase()
    if (!k) continue
    if (k === proc || k === proc.replace(/\.exe$/, '') || (k.length >= 3 && title.includes(k)))
      return kind
  }
  if (isTerminalTarget(target)) return 'code'
  const byProcess = PROCESS_KINDS[proc]
  if (byProcess) return byProcess
  for (const [re, kind] of TITLE_KINDS) if (re.test(target.title)) return kind
  return 'other'
}

export function styleFor(
  kind: DictationAppKind,
  styles: Partial<Record<DictationAppKind, DictationStyle>> = {}
): DictationStyle {
  return styles[kind] ?? DICTATION_STYLE_DEFAULTS[kind]
}

export interface StyleContext {
  /** Last characters already in the field: mid-sentence text starts lowercase. */
  valueTail?: string
  /** Words whose capitals always stay (the personal dictionary). */
  keepCase?: readonly string[]
}

const SENTENCE_START = /(^|[.!?]["')\]]*\s+|\n\s*(?:\d+\.\s+|-\s+)?)(\p{Lu})(\p{L}*)/gu

/** Words that keep their capital: "I", acronyms, mixed case, dictionary terms. */
function keepsCapital(word: string, keep: ReadonlySet<string>): boolean {
  if (/^I(?:'|’|$)/.test(word)) return true
  if (word.length > 1 && word === word.toUpperCase()) return true
  if (/\p{Lu}/u.test(word.slice(1))) return true
  return keep.has(word.toLowerCase())
}

function lowerStarts(text: string, keep: ReadonlySet<string>, firstOnly: boolean): string {
  let n = 0
  return text.replace(SENTENCE_START, (m, pre: string, c: string, rest: string) => {
    if (firstOnly && n++ > 0) return m
    const word = c + rest
    return keepsCapital(word, keep) ? m : pre + c.toLowerCase() + rest
  })
}

const oneLine = (t: string): boolean => !/\n/.test(t) && !/[.!?]\s+\S/.test(t)

/** Applies `style` to formatted dictation. Only capitals and the final full stop change. */
export function applyStyle(text: string, style: DictationStyle, ctx: StyleContext = {}): string {
  if (!text) return text
  const keep = new Set((ctx.keepCase ?? []).flatMap((w) => w.toLowerCase().split(/\s+/)))
  let t = text
  // Joined onto an unfinished sentence: no capital at the start.
  const tail = (ctx.valueTail ?? '').trimEnd()
  if (tail && !/[.!?:\n]["')\]]*$/.test(tail)) t = lowerStarts(t, keep, true)
  switch (style) {
    case 'formal':
      if (/[\p{L}\p{N}]$/u.test(t) && !/\n/.test(t)) t += '.'
      break
    case 'casual':
      if (oneLine(t)) t = t.replace(/(?<!\.)\.$/, '')
      break
    case 'very-casual':
      t = lowerStarts(t, keep, false).replace(/(?<!\.)\.$/, '')
      break
    case 'code':
      t = lowerStarts(t, keep, true)
      if (oneLine(t)) t = t.replace(/(?<!\.)\.$/, '')
      break
    case 'off':
      break
  }
  return t
}
