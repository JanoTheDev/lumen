// IPC for the 11 Phase C lesson features: helper handoff (T24), practice challenges (T22),
// tutorial → lesson (T12).
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, statSync } from 'fs'
import { basename } from 'path'
import type { ChallengeView, TutorialImportResult } from '@shared/channels'
import {
  challengeStartSchema,
  handoffExportSchema,
  handoffIdSchema,
  tutorialImportSchema
} from '@shared/ipc'
import { INVALID, safeParse } from '../ipc/validate'
import { importTutorialFrom, skillRegistry, userSkillsRoot } from '.'
import { challengeRunner } from './challenge-install'
import {
  exportHandoff,
  installHandoffFromFile,
  listHandoffs,
  removeHandoff,
  type HandoffDeps
} from './handoff'

const deps: HandoffDeps = { registry: skillRegistry, skillsRoot: userSkillsRoot }

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024

async function pickSubtitles(
  sender: Electron.WebContents
): Promise<{ text: string; name: string } | { error: string }> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Open a subtitle file',
    filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'txt'] }],
    properties: ['openFile']
  }
  const parent = BrowserWindow.fromWebContents(sender)
  const pick = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts)
  const file = pick.filePaths[0]
  if (pick.canceled || !file) return { error: 'cancelled' }
  if (statSync(file).size > MAX_SUBTITLE_BYTES) return { error: 'the file is larger than 2 MB' }
  return { text: readFileSync(file, 'utf8'), name: basename(file) }
}

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
  ipcMain.handle(
    'teach:import-tutorial',
    async (e, raw: unknown): Promise<TutorialImportResult | typeof INVALID> => {
      const req = safeParse('teach:import-tutorial', tutorialImportSchema, raw)
      if (!req) return INVALID
      if (req.kind === 'file') {
        const f = await pickSubtitles(e.sender)
        if ('error' in f) return { ok: false, error: f.error }
        return importTutorialFrom({ kind: 'subtitles', text: f.text, name: f.name }, req.appId)
      }
      const src =
        req.kind === 'url'
          ? { kind: 'url' as const, url: req.url }
          : { kind: 'text' as const, text: req.text }
      return importTutorialFrom(src, req.appId)
    }
  )
  ipcMain.handle('teach:challenge-stop', () => ({ ok: !!challengeRunner()?.stop() }))
}
