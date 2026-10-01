// Scratchpad / notes (04 T45): "take a note …", dictation with no text field to type into,
// and "save to notes" from other features land in ~/.ai-overlay/notes.json, listed in Home.
// Local only; secrets are redacted before a note is stored.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { Note, NoteSource } from '@shared/dictation-history'
import { redactForLog } from '../../actions/redact'
import { configPath } from '../../config'
import { countWords, recordStats } from './stats'

export const MAX_NOTES = 1000
export const MAX_NOTE_TEXT = 10_000
const VIA: readonly Note['via'][] = ['voice', 'scratchpad', 'web', 'manual']

export interface AddNoteInput {
  text: string
  source?: NoteSource
  /** Default 'manual'. */
  via?: Note['via']
  /** Epoch ms; default now. */
  t?: number
}

export function notesFile(): string {
  return join(dirname(configPath()), 'notes.json')
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

function cleanSource(s: NoteSource | undefined): NoteSource | undefined {
  if (!s) return undefined
  const out: NoteSource = {}
  const title = str(s.title, 200)
  const url = str(s.url, 2000)
  const app = str(s.app, 80)
  if (title) out.title = redactForLog(title)
  if (url && /^https?:\/\//i.test(url)) out.url = redactForLog(url)
  if (app) out.app = app
  return Object.keys(out).length ? out : undefined
}

function cleanText(text: string): string {
  return redactForLog(text.trim()).slice(0, MAX_NOTE_TEXT)
}

function parseNote(v: unknown): Note | null {
  if (!v || typeof v !== 'object') return null
  const n = v as Partial<Note>
  if (typeof n.id !== 'string' || typeof n.text !== 'string' || typeof n.t !== 'number') return null
  const note: Note = {
    id: n.id,
    t: n.t,
    text: n.text,
    via: n.via && VIA.includes(n.via) ? n.via : 'manual'
  }
  if (typeof n.updated === 'number') note.updated = n.updated
  const source = cleanSource(n.source)
  if (source) note.source = source
  return note
}

/** Oldest first. */
function readNotes(): Note[] {
  const file = notesFile()
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { notes?: unknown }
    if (!Array.isArray(raw.notes)) return []
    return raw.notes.map(parseNote).filter((n): n is Note => n !== null)
  } catch {
    return []
  }
}

function writeNotes(notes: Note[]): void {
  const file = notesFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, notes }, null, 1), 'utf8')
  renameSync(tmp, file)
}

/** Newest first. */
export function listNotes(): Note[] {
  return readNotes().reverse()
}

/**
 * Saves a note (for other features too, e.g. "save to notes" from a web page). Throws on
 * empty text. The oldest notes go once there are more than MAX_NOTES.
 */
export function addNote(input: AddNoteInput): Note {
  const text = cleanText(input.text)
  if (!text) throw new Error('empty note')
  const note: Note = {
    id: randomUUID(),
    t: input.t ?? Date.now(),
    text,
    via: input.via && VIA.includes(input.via) ? input.via : 'manual'
  }
  const source = cleanSource(input.source)
  if (source) note.source = source
  writeNotes([...readNotes(), note].slice(-MAX_NOTES))
  return note
}

export function updateNote(id: string, text: string, now = Date.now()): Note | null {
  const clean = cleanText(text)
  if (!clean) return null
  const notes = readNotes()
  const i = notes.findIndex((n) => n.id === id)
  if (i < 0) return null
  const note: Note = { ...notes[i], text: clean, updated: now }
  notes[i] = note
  writeNotes(notes)
  return note
}

export function getNote(id: string): Note | undefined {
  return readNotes().find((n) => n.id === id)
}

export function deleteNote(id: string): boolean {
  const notes = readNotes()
  const kept = notes.filter((n) => n.id !== id)
  if (kept.length === notes.length) return false
  writeNotes(kept)
  return true
}

export function clearNotes(): void {
  writeNotes([])
}

// ---- "take a note …" ----

const NOTE_CMD_RE =
  /^(?:(?:hey\s+)?lumen[\s,]+)?(?:please\s+)?(?:(?:take|make|save)\s+(?:a\s+|me\s+a\s+)?(?:quick\s+)?note(?:\s+(?:that|saying|of))?|note\s+to\s+self|jot\s+(?:this\s+|that\s+)?down)(?:[\s,:;.!-]+|$)([\s\S]*)$/i
// "take a note in OneNote" is a request to act in an app, not a note for Lumen.
const APP_TARGET_RE = /^(?:in|on|into|inside)\s/i

/**
 * The note text of a "take a note …" utterance: null when it is not one, "" when the
 * command came without any text.
 */
export function matchTakeNote(utterance: string): string | null {
  const m = NOTE_CMD_RE.exec(utterance.trim())
  if (!m) return null
  const body = m[1].trim()
  if (APP_TARGET_RE.test(body)) return null
  const text = body.replace(/^[\s,:;.!-]+/, '').trim()
  if (!text || /^[.!?]+$/.test(text)) return ''
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const preview = (s: string): string => (s.length > 60 ? `${s.slice(0, 59)}…` : s)

/**
 * "take a note …" on the assistant hotkey: saves the note and says so on the bar. Returns
 * false for anything else so the utterance goes on as usual.
 */
export async function handleNoteCommand(utterance: string): Promise<boolean> {
  const text = matchTakeNote(utterance)
  if (text === null) return false
  const { setStatus } = await import('../../windows/assistant')
  if (!text) {
    setStatus('answer', 'Say “take a note” and then what the note should say', undefined, 4000)
    return true
  }
  try {
    const note = addNote({ text, via: 'voice' })
    recordStats({ words: countWords(text), t: note.t })
    setStatus('answer', `Noted: ${preview(note.text)} (Home, Notes)`, undefined, 4000)
  } catch (e) {
    console.error('[notes] not saved:', (e as Error).message)
    setStatus('error', 'Could not save the note', undefined, 4000)
  }
  return true
}
