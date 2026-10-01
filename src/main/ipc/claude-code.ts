// Claude Code copilot IPC (08 T40): Settings → Claude Code. Every payload is validated; the
// global hooks are written only with the hash of the preview the user confirmed.
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, statSync } from 'fs'
import { z } from 'zod'
import {
  claudeHooksWriteSchema,
  claudeIdSchema,
  claudeOpenSchema,
  claudePathSchema,
  claudePermissionAnswerSchema,
  claudeProjectEntrySchema,
  claudeSendSchema,
  claudeSettingsPatchSchema
} from '@shared/claude-code'
import { INVALID, safeParse } from './validate'
import { cliStatus } from '../claude-code/cli'
import {
  allProjects,
  copilotStore,
  getBridge,
  getCopilot,
  hookBase,
  hooksApply,
  hooksPreview
} from '../claude-code'
import { samePath } from '../claude-code/projects'

const installSchema = z.boolean()

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function registerClaudeCodeIpc(): void {
  ipcMain.handle('claude:status', async () => {
    const st = copilotStore()
    const settings = st.settings()
    return {
      cli: await cliStatus(settings.cliPath),
      settings,
      hookPort: hookBase() ? Number(hookBase()!.split(':').pop()) : 0,
      sessions: getCopilot()?.list() ?? [],
      pending: getBridge()?.list() ?? []
    }
  })

  ipcMain.handle('claude:settings-set', (_e, raw: unknown) => {
    const patch = safeParse('claude:settings-set', claudeSettingsPatchSchema, raw)
    if (!patch) return INVALID
    const st = copilotStore()
    return st.saveSettings({ ...st.settings(), ...patch })
  })

  ipcMain.handle('claude:projects', () => allProjects())

  ipcMain.handle('claude:project-set', (_e, raw: unknown) => {
    const entry = safeParse('claude:project-set', claudeProjectEntrySchema, raw)
    if (!entry) return INVALID
    if (!isDir(entry.path)) return { ok: false, error: 'That folder does not exist.' }
    const st = copilotStore()
    const s = st.settings()
    const rest = s.projects.filter((p) => !samePath(p.path, entry.path))
    st.saveSettings({ ...s, projects: [...rest, entry] })
    return { ok: true }
  })

  ipcMain.handle('claude:project-remove', (_e, raw: unknown) => {
    const path = safeParse('claude:project-remove', claudePathSchema, raw)
    if (!path) return INVALID
    const st = copilotStore()
    const s = st.settings()
    st.saveSettings({ ...s, projects: s.projects.filter((p) => !samePath(p.path, path)) })
    return { ok: true }
  })

  ipcMain.handle('claude:pick-folder', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const opts = { properties: ['openDirectory' as const], title: 'Add a project folder' }
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('claude:open', async (_e, raw: unknown) => {
    const req = safeParse('claude:open', claudeOpenSchema, raw)
    const c = getCopilot()
    if (!req || !c) return INVALID
    const project = allProjects().find((p) => samePath(p.path, req.project))
    if (!project) return { ok: false, error: 'Unknown project.' }
    try {
      const session = await c.open(project, { prompt: req.prompt, resume: req.resume })
      return { ok: true, session }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('claude:send', (_e, raw: unknown) => {
    const req = safeParse('claude:send', claudeSendSchema, raw)
    const c = getCopilot()
    if (!req || !c) return INVALID
    try {
      c.send(req.id, req.text)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('claude:interrupt', async (_e, raw: unknown) => {
    const id = safeParse('claude:interrupt', claudeIdSchema, raw)
    if (!id) return INVALID
    return { ok: (await getCopilot()?.interrupt(id)) ?? false }
  })

  ipcMain.handle('claude:close', (_e, raw: unknown) => {
    const id = safeParse('claude:close', claudeIdSchema, raw)
    if (!id) return INVALID
    return { ok: getCopilot()?.close(id) ?? false }
  })

  ipcMain.handle('claude:permission-answer', (_e, raw: unknown) => {
    const req = safeParse('claude:permission-answer', claudePermissionAnswerSchema, raw)
    if (!req) return INVALID
    return { ok: getBridge()?.answer(req.answer, req.id) ?? false }
  })

  ipcMain.handle('claude:hooks-preview', (_e, raw: unknown) => {
    const install = safeParse('claude:hooks-preview', installSchema, raw)
    if (install === undefined) return INVALID
    try {
      return hooksPreview(install)
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('claude:hooks-apply', (_e, rawInstall: unknown, rawHash: unknown) => {
    const install = safeParse('claude:hooks-apply', installSchema, rawInstall)
    const req = safeParse('claude:hooks-apply', claudeHooksWriteSchema, { hash: rawHash })
    if (install === undefined || !req) return INVALID
    return hooksApply(install, req.hash)
  })
}
