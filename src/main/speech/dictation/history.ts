// Dictation history (04 T44): the last dictations with app, time, raw and cleaned text, in
// ~/.ai-overlay/dictation/history.jsonl. Local only, never written to main.log. Secrets are
// redacted before anything is stored; at most MAX_ENTRIES, none older than KEEP_DAYS. Off
// with `dictation.history: false` or while memory private mode is on. Stats (T46) count
// every dictation either way, without text.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { DictationHistoryEntry, DictationSource } from '@shared/dictation-history'
import { redactForLog } from '../../actions/redact'
import { loadConfig } from '../../config'
import { dictationDir } from './recovery'
import { countWords, recordStats } from './stats'

export const MAX_ENTRIES = 500
export const KEEP_DAYS = 30
const MAX_TEXT = 4000
const SOURCES: readonly DictationSource[] = ['hotkey', 'auto', 'command', 'snippet', 'note']

/** What the dictation pipeline reports after each dictation (typed or not). */
export interface DictationRecord {
  /** Transcript before any cleanup. */
  raw: string
  /** Final text that was typed (or would have been). */
  text: string
  /** Process name of the target window. */
  app?: string
  /** Speaking time of the recording, for WPM. */
  durationMs?: number
  source?: DictationSource
  /** False when nothing was typed (failed insert, refused field). Default true. */
  ok?: boolean
  /** Style applied (T36), shown in the list. */
  style?: string
  /** Epoch ms; default now. */
  t?: number
}

function historyFile(): string {
  return join(dictationDir(), 'history.jsonl')
}

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)

/** Redacted, capped entry ready to store. Pure apart from the id. */
export function toEntry(r: DictationRecord, now = Date.now()): DictationHistoryEntry {
  const text = clip(redactForLog(r.text.trim()))
  const raw = clip(redactForLog(r.raw.trim()))
  const entry: DictationHistoryEntry = {
    id: randomUUID(),
    t: r.t ?? now,
    app: (r.app ?? '').slice(0, 80),
    raw,
    text,
    words: countWords(r.text),
    source: r.source && SOURCES.includes(r.source) ? r.source : 'hotkey',
    ok: r.ok !== false
  }
  if (r.durationMs && r.durationMs > 0) entry.durationMs = Math.round(r.durationMs)
  if (r.style) entry.style = r.style.slice(0, 40)
  return entry
}

function parseLine(line: string): DictationHistoryEntry | null {
  try {
    const v = JSON.parse(line) as Partial<DictationHistoryEntry>
    if (typeof v.id !== 'string' || typeof v.t !== 'number' || typeof v.text !== 'string')
      return null
    return {
      id: v.id,
      t: v.t,
      app: typeof v.app === 'string' ? v.app : '',
      raw: typeof v.raw === 'string' ? v.raw : v.text,
      text: v.text,
      words: typeof v.words === 'number' ? v.words : countWords(v.text),
      ...(typeof v.durationMs === 'number' ? { durationMs: v.durationMs } : {}),
      source: v.source && SOURCES.includes(v.source) ? v.source : 'hotkey',
      ok: v.ok !== false,
      ...(typeof v.style === 'string' ? { style: v.style } : {})
    }
  } catch {
    return null
  }
}

/** Keeps the newest MAX_ENTRIES entries from the last KEEP_DAYS, oldest first. Pure. */
export function prune(entries: DictationHistoryEntry[], now = Date.now()): DictationHistoryEntry[] {
  const cutoff = now - KEEP_DAYS * 86_400_000
  return entries.filter((e) => e.t >= cutoff).slice(-MAX_ENTRIES)
}

function readAll(): DictationHistoryEntry[] {
  const file = historyFile()
  if (!existsSync(file)) return []
  const out: DictationHistoryEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const e = parseLine(line)
    if (e) out.push(e)
  }
  return out
}

function writeAll(entries: DictationHistoryEntry[]): void {
  mkdirSync(dictationDir(), { recursive: true })
  writeFileSync(historyFile(), entries.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8')
}

/** Newest first, pruned. */
export function listHistory(now = Date.now()): DictationHistoryEntry[] {
  const all = readAll()
  const kept = prune(all, now)
  if (kept.length !== all.length) writeAll(kept)
  return kept.reverse()
}

export function getHistoryEntry(id: string): DictationHistoryEntry | undefined {
  return readAll().find((e) => e.id === id)
}

export function deleteHistoryEntry(id: string): boolean {
  const all = readAll()
  const kept = all.filter((e) => e.id !== id)
  if (kept.length === all.length) return false
  writeAll(kept)
  return true
}

export function clearHistory(): void {
  rmSync(historyFile(), { force: true })
}

export function historyEnabled(): boolean {
  const cfg = loadConfig()
  return cfg.dictation.history !== false && !cfg.memory.privateMode
}

/** Appends one entry; compacts the file when it has grown past the cap. */
export function appendHistory(entry: DictationHistoryEntry, now = Date.now()): void {
  mkdirSync(dictationDir(), { recursive: true })
  appendFileSync(historyFile(), JSON.stringify(entry) + '\n', 'utf8')
  const all = readAll()
  const oldest = all[0]?.t ?? now
  if (all.length > MAX_ENTRIES + 50 || oldest < now - KEEP_DAYS * 86_400_000)
    writeAll(prune(all, now))
}

/**
 * The dictation pipeline's recorder: history (when on) + stats. Never throws, so a full disk
 * or a bad file never breaks typing.
 */
export function recordDictation(r: DictationRecord): void {
  if (!r.text.trim() && !r.raw.trim()) return
  try {
    const now = Date.now()
    const entry = toEntry(r, now)
    if (historyEnabled()) appendHistory(entry, now)
    if (entry.ok) recordStats({ words: entry.words, durationMs: entry.durationMs, t: entry.t })
  } catch (e) {
    console.error('[dictation] history not saved:', (e as Error).message)
  }
}
