// Lesson picker IPC (07 T22, T29): list, start / resume, reviews, commands, progress, the user's
// own lessons, and the onboarding practice board's clicks.
import { ipcMain } from 'electron'
import { lessonCommandSchema, lessonIdSchema, nameSchema, practiceLabelSchema } from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import {
  deleteLesson,
  lessonCommand,
  lessonProgress,
  listLessons,
  practiceClick,
  saveGeneratedLesson,
  startOrResume,
  startReview
} from '../teach'

export function registerTeachIpc(): void {
  ipcMain.handle('teach:list', (_e, raw: unknown) => {
    const appId = raw === undefined ? undefined : safeParse('teach:list', lessonIdSchema, raw)
    if (raw !== undefined && !appId) return INVALID
    return listLessons(appId)
  })
  ipcMain.handle('teach:start', (_e, raw: unknown) => {
    const id = safeParse('teach:start', lessonIdSchema, raw)
    if (!id) return INVALID
    return startOrResume(id) ? { ok: true } : { ok: false, error: 'not found' }
  })
  ipcMain.handle('teach:command', (_e, raw: unknown) => {
    const cmd = safeParse('teach:command', lessonCommandSchema, raw)
    return { ok: !!cmd && lessonCommand(cmd) }
  })
  ipcMain.handle('teach:progress', () => lessonProgress())
  ipcMain.handle('teach:review', (_e, raw: unknown) => {
    const id = safeParse('teach:review', lessonIdSchema, raw)
    return id ? startReview(id) : INVALID
  })
  ipcMain.handle('teach:delete', (_e, raw: unknown) => {
    const id = safeParse('teach:delete', lessonIdSchema, raw)
    return { ok: !!id && deleteLesson(id) }
  })
  ipcMain.handle('teach:save-last', (_e, raw: unknown) => {
    const name = raw === undefined ? undefined : safeParse('teach:save-last', nameSchema, raw)
    if (raw !== undefined && name === undefined) return INVALID
    const saved = saveGeneratedLesson(name)
    return saved
      ? { id: saved.id, title: saved.title }
      : { error: 'no lesson to save — ask "show me how" first' }
  })
  ipcMain.on('teach:practice', (_e, raw: unknown) => {
    const label = safeParse('teach:practice', practiceLabelSchema, raw)
    if (label) practiceClick(label)
  })
}
