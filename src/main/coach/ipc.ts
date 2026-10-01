// Settings → Smart helpers IPC (11 T17/T18/T23): the learning journal and what the shortcut
// coach and fatigue proposals remember.
import { ipcMain } from 'electron'
import { journalDateSchema } from '@shared/ipc'
import { INVALID, safeParse } from '../ipc/validate'
import { coachStatus, journalStore, resetCoach } from '.'

export function registerHelpersIpc(): void {
  ipcMain.handle('helpers:journal-days', () => journalStore()?.days() ?? [])
  ipcMain.handle('helpers:journal-read', (_e, raw: unknown) => {
    const date = safeParse('helpers:journal-read', journalDateSchema, raw)
    if (!date) return INVALID
    const markdown = journalStore()?.markdown(date)
    return markdown == null ? { ok: false } : { ok: true, markdown }
  })
  ipcMain.handle('helpers:journal-clear', () => {
    journalStore()?.clear()
    return { ok: true }
  })
  ipcMain.handle('helpers:coach-status', () => coachStatus())
  ipcMain.handle('helpers:coach-reset', () => {
    resetCoach()
    return { ok: true }
  })
}
