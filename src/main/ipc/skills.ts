// Settings → Skills IPC (11 T05/T06): list, view, edit, switch on/off, trust, create, delete,
// install with a permissions preview, and export.
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  packUrlSchema,
  skillDescriptionSchema,
  skillNameSchema,
  skillTextSchema,
  skillTokenSchema
} from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import {
  cancelPending,
  exportSkillFile,
  installPending,
  listSkillSummaries,
  newSkill,
  previewSkillFile,
  previewSkillUrl,
  removeSkill,
  saveSkill,
  setSkillEnabled,
  setSkillTrusted,
  skillDetail
} from '../skills'

const nameFlag = z.tuple([skillNameSchema, z.boolean()])
const nameText = z.tuple([skillNameSchema, skillTextSchema])
const nameDescription = z.tuple([skillNameSchema, skillDescriptionSchema])

export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', () => listSkillSummaries())
  ipcMain.handle('skills:get', (_e, raw: unknown) => {
    const name = safeParse('skills:get', skillNameSchema, raw)
    return name ? skillDetail(name) : INVALID
  })
  ipcMain.handle('skills:set-enabled', (_e, ...raw: unknown[]) => {
    const args = safeParse('skills:set-enabled', nameFlag, raw)
    return { ok: !!args && setSkillEnabled(args[0], args[1]) }
  })
  ipcMain.handle('skills:set-trusted', (_e, ...raw: unknown[]) => {
    const args = safeParse('skills:set-trusted', nameFlag, raw)
    return { ok: !!args && setSkillTrusted(args[0], args[1]) }
  })
  ipcMain.handle('skills:save', (_e, ...raw: unknown[]) => {
    const args = safeParse('skills:save', nameText, raw)
    return args ? saveSkill(args[0], args[1]) : INVALID
  })
  ipcMain.handle('skills:create', (_e, ...raw: unknown[]) => {
    const args = safeParse('skills:create', nameDescription, raw)
    return args ? newSkill(args[0], args[1]) : INVALID
  })
  ipcMain.handle('skills:delete', (_e, raw: unknown) => {
    const name = safeParse('skills:delete', skillNameSchema, raw)
    return name ? removeSkill(name) : INVALID
  })
  ipcMain.handle('skills:preview-file', (e) => previewSkillFile(e.sender))
  ipcMain.handle('skills:preview-url', (_e, raw: unknown) => {
    const url = safeParse('skills:preview-url', packUrlSchema, raw)
    return url ? previewSkillUrl(url) : INVALID
  })
  ipcMain.handle('skills:install', (_e, raw: unknown) => {
    const token = safeParse('skills:install', skillTokenSchema, raw)
    return token ? installPending(token) : INVALID
  })
  ipcMain.handle('skills:install-cancel', (_e, raw: unknown) => {
    const token = safeParse('skills:install-cancel', skillTokenSchema, raw)
    return { ok: !!token && cancelPending(token) }
  })
  ipcMain.handle('skills:export', (e, raw: unknown) => {
    const name = safeParse('skills:export', skillNameSchema, raw)
    return name ? exportSkillFile(name, e.sender) : INVALID
  })
}
