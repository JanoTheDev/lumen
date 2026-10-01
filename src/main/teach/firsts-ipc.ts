// IPC for the 11 Phase C lesson features: helper handoff (T24).
import { ipcMain } from 'electron'
import { handoffExportSchema, handoffIdSchema } from '@shared/ipc'
import { INVALID, safeParse } from '../ipc/validate'
import { skillRegistry, userSkillsRoot } from '.'
import {
  exportHandoff,
  installHandoffFromFile,
  listHandoffs,
  removeHandoff,
  type HandoffDeps
} from './handoff'

const deps: HandoffDeps = { registry: skillRegistry, skillsRoot: userSkillsRoot }

export function registerFirstsIpc(): void {
  ipcMain.handle('teach:handoff-export', (e, raw: unknown) => {
    const req = safeParse('teach:handoff-export', handoffExportSchema, raw)
    if (!req) return INVALID
    return exportHandoff(deps, req, e.sender)
  })
  ipcMain.handle('teach:handoff-install', (e) => installHandoffFromFile(deps, e.sender))
  ipcMain.handle('teach:handoff-list', () => listHandoffs(deps))
  ipcMain.handle('teach:handoff-remove', (_e, raw: unknown) => {
    const id = safeParse('teach:handoff-remove', handoffIdSchema, raw)
    if (!id) return INVALID
    return { ok: removeHandoff(deps, id) }
  })
}
