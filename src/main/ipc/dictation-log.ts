// Dictation history, stats and notes for the Home flyout (04 T44-T46). Registered from
// registerVoiceIpc. Copy goes through the main-process clipboard; "type again" waits for the
// flyout to close so the text lands in the field the user was in.
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

async function typeAgain(text: string): Promise<{ ok: boolean; notice?: string }> {
  const { getAgent } = await import('../agent/instance')
  const { insertDictation, readFocus } = await import('../speech/dictation/insert')
  const agent = getAgent()
  if (!agent) return { ok: false, notice: 'The helper process is not running' }
  await new Promise((r) => setTimeout(r, REFOCUS_MS))
  const target = await readFocus(agent)
  if (target.uia && !target.editable)
    return { ok: false, notice: 'Click into a text field first, then try again' }
  const res = await insertDictation(agent, text, target, loadConfig().dictation.terminal)
  return res.ok ? { ok: true, notice: res.notice } : { ok: false, notice: res.notice }
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
    if (!entry) return { ok: false, notice: 'That dictation is gone' }
    try {
      return await typeAgain(entry.text)
    } catch (e) {
      return { ok: false, notice: (e as Error).message }
    }
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
