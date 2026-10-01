// Dictation history, stats and notes for the Home flyout (04 T44-T46). Registered from
// registerVoiceIpc. Copy goes through the main-process clipboard; "type again" waits for the
// flyout to close so the text lands in the field the user was in, uses Shift+Enter for line
// breaks where Enter may send, and says the outcome on the bar (the flyout is gone by then).
import { clipboard, ipcMain } from 'electron'
import { entryIdSchema, noteTextSchema } from '@shared/ipc'
import type { DictationStatsView } from '@shared/dictation-history'
import { INVALID, safeParse } from './validate'
import { loadConfig } from '../config'
import {
  clearHistory,
  deleteHistoryEntry,
  getHistoryEntry,
  historyEnabled,
  listHistory
} from '../speech/dictation/history'
import { addNote, deleteNote, getNote, listNotes, updateNote } from '../speech/dictation/notes'
import { loadStats, resetStats, summarize } from '../speech/dictation/stats'

/** Time for the flyout to hide and the previous window to take focus back. */
const REFOCUS_MS = 350

export const REDACTED_NOTICE =
  'That dictation had a secret taken out, so it cannot be typed again. Copy it instead.'

async function typeAgain(text: string): Promise<{ ok: boolean; notice?: string }> {
  const { getAgent } = await import('../agent/instance')
  const { insertDictation, readFocus } = await import('../speech/dictation/insert')
  const { appKindOf, softBreaksFor } = await import('../speech/dictation/styles')
  const agent = getAgent()
  if (!agent) return { ok: false, notice: 'The helper process is not running' }
  await new Promise((r) => setTimeout(r, REFOCUS_MS))
  const target = await readFocus(agent)
  if (target.uia && !target.editable)
    return { ok: false, notice: 'Click into a text field first, then try again' }
  const cfg = loadConfig().dictation
  const res = await insertDictation(agent, text, target, cfg.terminal, {
    softBreaks: softBreaksFor(appKindOf(target, cfg.styleApps))
  })
  return res.ok ? { ok: true, notice: res.notice } : { ok: false, notice: res.notice }
}

/** The flyout closed before the result: the outcome goes on the bar. */
async function tell(res: { ok: boolean; notice?: string }): Promise<void> {
  try {
    const { setStatus } = await import('../windows/assistant')
    if (res.ok) setStatus('answer', res.notice ?? 'Typed', undefined, res.notice ? 4000 : 1200)
    else setStatus('error', res.notice ?? 'Could not type it', undefined, 4000)
  } catch {
    // No bar (tests, shutdown): the invoke result still carries the notice.
  }
}

function copy(text: string | undefined): { ok: boolean } {
  if (!text) return { ok: false }
  clipboard.writeText(text)
  return { ok: true }
}

export function registerDictationLogIpc(): void {
  ipcMain.handle('dictation:history', () => ({
    enabled: historyEnabled(),
    entries: listHistory()
  }))
  ipcMain.handle('dictation:history-delete', (_e, raw: unknown) => {
    const id = safeParse('dictation:history-delete', entryIdSchema, raw)
    if (id === undefined) return INVALID
    return { ok: deleteHistoryEntry(id) }
  })
  ipcMain.handle('dictation:history-clear', () => {
    clearHistory()
    return { ok: true }
  })
  ipcMain.handle('dictation:history-copy', (_e, raw: unknown) => {
    const id = safeParse('dictation:history-copy', entryIdSchema, raw)
    if (id === undefined) return INVALID
    return copy(getHistoryEntry(id)?.text)
  })
  ipcMain.handle('dictation:history-insert', async (_e, raw: unknown) => {
    const id = safeParse('dictation:history-insert', entryIdSchema, raw)
    if (id === undefined) return INVALID
    const entry = getHistoryEntry(id)
    let res: { ok: boolean; notice?: string }
    if (!entry) res = { ok: false, notice: 'That dictation is gone' }
    // The stored text has a redaction marker where the secret was: never type that (L5).
    else if (entry.text.includes('[redacted:')) res = { ok: false, notice: REDACTED_NOTICE }
    else
      try {
        res = await typeAgain(entry.text)
      } catch (e) {
        res = { ok: false, notice: (e as Error).message }
      }
    await tell(res)
    return res
  })
  ipcMain.handle(
    'dictation:stats',
    (): DictationStatsView => ({
      show: loadConfig().dictation.showStats === true,
      ...summarize(loadStats())
    })
  )
  ipcMain.handle('dictation:stats-reset', () => {
    resetStats()
    return { ok: true }
  })

  ipcMain.handle('notes:list', () => listNotes())
  ipcMain.handle('notes:add', (_e, raw: unknown) => {
    const text = safeParse('notes:add', noteTextSchema, raw)
    if (text === undefined) return INVALID
    return { ok: true, note: addNote({ text, via: 'manual' }) }
  })
  ipcMain.handle('notes:update', (_e, rawId: unknown, rawText: unknown) => {
    const id = safeParse('notes:update', entryIdSchema, rawId)
    const text = safeParse('notes:update', noteTextSchema, rawText)
    if (id === undefined || text === undefined) return INVALID
    return { ok: updateNote(id, text) !== null }
  })
  ipcMain.handle('notes:delete', (_e, raw: unknown) => {
    const id = safeParse('notes:delete', entryIdSchema, raw)
    if (id === undefined) return INVALID
    return { ok: deleteNote(id) }
  })
  ipcMain.handle('notes:copy', (_e, raw: unknown) => {
    const id = safeParse('notes:copy', entryIdSchema, raw)
    if (id === undefined) return INVALID
    return copy(getNote(id)?.text)
  })
}
