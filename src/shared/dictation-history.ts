// Dictation history, notes and stats (04 T44-T46) as the Home flyout sees them. Local only.

/** How a dictation was made. */
export type DictationSource = 'hotkey' | 'auto' | 'command' | 'snippet' | 'note'

export interface DictationHistoryEntry {
  id: string
  /** Epoch ms. */
  t: number
  /** Process that received the text ("" when unknown). */
  app: string
  /** Transcript before cleanup (secrets redacted). */
  raw: string
  /** Text that was typed (secrets redacted). */
  text: string
  words: number
  /** Speaking time, when the recorder knew it. */
  durationMs?: number
  source: DictationSource
  /** False when the text could not be typed (kept in recovered.txt). */
  ok: boolean
  style?: string
}

export interface DictationHistoryView {
  enabled: boolean
  entries: DictationHistoryEntry[]
}

export interface NoteSource {
  title?: string
  url?: string
  app?: string
}

export interface Note {
  id: string
  /** Epoch ms when created / last edited. */
  t: number
  updated?: number
  text: string
  /** voice: "take a note …"; scratchpad: dictation with no text field; web: "save to notes". */
  via: 'voice' | 'scratchpad' | 'web' | 'manual'
  source?: NoteSource
}

export interface DictationStatsView {
  /** Home shows the card only when the user turned it on. */
  show: boolean
  totalWords: number
  todayWords: number
  weekWords: number
  sessions: number
  /** Speaking pace from dictations with a known duration; 0 when none. */
  wpm: number
  /** Typing pace the saving is measured against. */
  typingWpm: number
  /** Typing time minus speaking time, never below 0. */
  savedMs: number
  /** Days in a row with dictation, ending today or yesterday. */
  streak: number
}
