// Lesson picker IPC (07 T22, T29, T31, T32): list, start / resume, reviews, commands, progress,
// the user's own lessons, record-my-steps drafts, community packs, and the onboarding practice
// board's clicks.
import { ipcMain } from 'electron'
import {
  lessonCommandSchema,
  lessonDraftEditSchema,
  lessonIdSchema,
  nameSchema,
  packUrlSchema,
  practiceLabelSchema,
  recordActionSchema
} from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import {
  discardDraft,
  playDraft,
  recordAction,
  recordStatus,
  saveDraft,
  deleteLesson,
  lessonCommand,
  lessonProgress,
  listLessons,
  practiceClick,
  saveGeneratedLesson,
  startOrResume,
  startReview
} from '../teach'
import {
  exportPack,
  installPackFromFile,
  installPackFromUrl,
  listCommunityPacks,
  removeCommunityPack
} from '../teach/packs'

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
  ipcMain.handle('teach:record', (_e, raw: unknown) => {
    const action = safeParse('teach:record', recordActionSchema, raw)
    return action ? recordAction(action) : INVALID
  })
  ipcMain.handle('teach:record-status', () => recordStatus())
  ipcMain.handle('teach:draft-save', (_e, raw: unknown) => {
    const edit = safeParse('teach:draft-save', lessonDraftEditSchema, raw)
    return edit ? saveDraft(edit) : INVALID
  })
  ipcMain.handle('teach:draft-play', () => ({ ok: playDraft() }))
  ipcMain.handle('teach:draft-discard', () => ({ ok: discardDraft() }))
  ipcMain.handle('teach:pack-list', () => listCommunityPacks())
  ipcMain.handle('teach:pack-install-file', (e) => installPackFromFile(e.sender))
  ipcMain.handle('teach:pack-install-url', (_e, raw: unknown) => {
    const url = safeParse('teach:pack-install-url', packUrlSchema, raw)
    return url ? installPackFromUrl(url) : INVALID
  })
  ipcMain.handle('teach:pack-remove', (_e, raw: unknown) => {
    const id = safeParse('teach:pack-remove', lessonIdSchema, raw)
    return { ok: !!id && removeCommunityPack(id) }
  })
  ipcMain.handle('teach:pack-export', (e, raw: unknown) => {
    const id = safeParse('teach:pack-export', lessonIdSchema, raw)
    return id ? exportPack(id, e.sender) : INVALID
  })
  ipcMain.on('teach:practice', (_e, raw: unknown) => {
    const label = safeParse('teach:practice', practiceLabelSchema, raw)
    if (label) practiceClick(label)
  })
}
