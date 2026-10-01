// IPC for the 11 Phase C lesson features: helper handoff (T24), practice challenges (T22).
import { ipcMain } from 'electron'
import type { ChallengeView } from '@shared/channels'
import { challengeStartSchema, handoffExportSchema, handoffIdSchema } from '@shared/ipc'
import { INVALID, safeParse } from '../ipc/validate'
import { skillRegistry, userSkillsRoot } from '.'
import { challengeRunner } from './challenge-install'
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
  ipcMain.handle('teach:challenge-status', (): ChallengeView => {
    const s = challengeRunner()?.status()
    return s ?? { active: null, streak: 0, best: 0, passed: 0, recent: [] }
  })
  ipcMain.handle('teach:challenge-start', async (_e, raw: unknown) => {
    const opts = safeParse('teach:challenge-start', challengeStartSchema, raw)
    if (!opts) return INVALID
    const r = challengeRunner()
    if (!r) return { ok: false, error: 'not ready' }
    // Settings names the app by pack id; the runner matches names.
    const app = opts.app ? (skillRegistry()?.get(opts.app)?.name ?? opts.app) : undefined
    const res = await r.start({ app, level: opts.level })
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  ipcMain.handle('teach:challenge-check', async () => {
    const r = challengeRunner()
    return r ? r.check() : { ok: false, text: 'not ready' }
  })
  ipcMain.handle('teach:challenge-stop', () => ({ ok: !!challengeRunner()?.stop() }))
}
