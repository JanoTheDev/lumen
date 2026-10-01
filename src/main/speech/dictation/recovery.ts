// Dictated text is written to disk the moment it is transcribed and removed once it has been
// typed. Whatever is still pending at the next launch (crash, kill, failed insert) is moved
// to recovered.txt and offered back to the user.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { configPath } from '../../config'

export interface PendingDictation {
  id: string
  /** Epoch ms when it was transcribed. */
  t: number
  text: string
}

export function dictationDir(): string {
  return join(dirname(configPath()), 'dictation')
}

function pendingFile(): string {
  return join(dictationDir(), 'pending.jsonl')
}

export function recoveredFile(): string {
  return join(dictationDir(), 'recovered.txt')
}

function readPending(): PendingDictation[] {
  const file = pendingFile()
  if (!existsSync(file)) return []
  const out: PendingDictation[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as Partial<PendingDictation>
      if (typeof v.id === 'string' && typeof v.text === 'string' && v.text.trim())
        out.push({ id: v.id, t: typeof v.t === 'number' ? v.t : 0, text: v.text })
    } catch {
      // A line torn by a crash mid-write is skipped.
    }
  }
  return out
}

/** Appends synchronously so the text survives a crash right after this call. */
export function savePending(text: string, now = Date.now()): string {
  const id = randomUUID()
  mkdirSync(dictationDir(), { recursive: true })
  appendFileSync(pendingFile(), JSON.stringify({ id, t: now, text }) + '\n', 'utf8')
  return id
}

/** Drops one entry after its text was typed. */
export function clearPending(id: string): void {
  const rest = readPending().filter((p) => p.id !== id)
  if (rest.length)
    writeFileSync(pendingFile(), rest.map((p) => JSON.stringify(p)).join('\n') + '\n')
  else rmSync(pendingFile(), { force: true })
}

/** Moves one entry straight to recovered.txt (typing failed; the text is shown now). */
export function archivePending(id: string): void {
  const all = readPending()
  const item = all.find((p) => p.id === id)
  if (!item) return
  appendFileSync(recoveredFile(), `[${new Date(item.t).toISOString()}]\n${item.text}\n\n`, 'utf8')
  clearPending(id)
}

/**
 * Moves every pending entry to recovered.txt and returns them (oldest first). Run once at
 * startup, before any new dictation.
 */
export function takeRecoverable(): PendingDictation[] {
  const items = readPending().sort((a, b) => a.t - b.t)
  if (!items.length) {
    rmSync(pendingFile(), { force: true })
    return []
  }
  const block = items.map((p) => `[${new Date(p.t).toISOString()}]\n${p.text}\n`).join('\n')
  appendFileSync(recoveredFile(), block + '\n', 'utf8')
  rmSync(pendingFile(), { force: true })
  return items
}

/** Answer-card text for recovered dictation. */
export function recoveryMessage(items: PendingDictation[]): string {
  const body = items.map((p) => p.text.trim()).join('\n\n')
  const where = `Also saved in ${recoveredFile()}`
  return `Recovered dictation that was not typed last time:\n\n${body}\n\n${where}`
}
