// firstrun:* channels for the setup flow, wired to the real probes.
import { app, ipcMain, shell, systemPreferences } from 'electron'
import { z } from 'zod'
import { INVALID, safeParse } from '../ipc/validate'
import { loadConfig } from '../config'
import { getAgent } from '../agent/instance'
import { ocr, systemInfo } from '../agent/commands'
import { KEY_PROVIDERS, hasKey } from '../keys/vault'
import { installWakeModel } from '../ipc/wake'
import { patchConfig } from '../ipc/settings'
import { captureNextHotkey } from '../speech/hotkey'
import { wakeStatus } from '../speech/wake'
import { CHECK_IDS, fixCheck, listChecks, runCheck, type CheckProbes } from './checks'

const idSchema = z.enum(CHECK_IDS)

/** The setup hotkey test: the press is consumed, so it does not start a voice turn. */
function waitForHotkey(ms: number): Promise<boolean> {
  if (!getAgent()) return Promise.resolve(false)
  return captureNextHotkey(ms)
}

let elevatedCache: boolean | null = null

/** Running as administrator, from the agent's process token (it inherits Lumen's). */
export async function elevated(): Promise<boolean> {
  if (elevatedCache !== null) return elevatedCache
  const agent = getAgent()
  if (!agent?.running) return false
  try {
    elevatedCache = (await systemInfo(agent, { timeoutMs: 3000 })).elevated === true
    return elevatedCache
  } catch {
    return false
  }
}

/** Tests only. */
export function resetElevatedCache(): void {
  elevatedCache = null
}

const probes: CheckProbes = {
  keyProviders: () => KEY_PROVIDERS.filter((p) => hasKey(p)),
  localMode: () => loadConfig().models.provider === 'local',
  micAccess: () =>
    process.platform === 'win32' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
  agent: () => {
    const a = getAgent()
    if (!a) return null
    return { running: a.running, version: a.version, error: a.lastError }
  },
  hotkey: () => loadConfig().hotkey,
  waitForHotkey,
  ocr: async () => {
    const agent = getAgent()
    if (!agent?.running) throw new Error('the helper is not running')
    try {
      await ocr(agent, { region: { x: 0, y: 0, w: 320, h: 120 } }, { timeoutMs: 8000 })
    } catch (e) {
      const err = e as Error & { code?: string }
      // The helper itself lacks OCR: not a missing language pack.
      if (err.code === 'E_UNSUPPORTED' && /unsupported by/.test(err.message)) {
        throw new Error('this helper cannot read the screen')
      }
      throw err
    }
  },
  wakeEnabled: () => loadConfig().wakeWord.enabled,
  wakeUnavailable: () => wakeStatus().unavailable,
  wakeModelInstalled: () => wakeStatus().installed,
  wakeModelSizeMb: () => wakeStatus().sizeMb,
  installWakeModel,
  restartAgent: async () => {
    const agent = getAgent()
    if (!agent) throw new Error('the helper is not set up')
    agent.stop()
    await agent.start()
  },
  elevated,
  openUri: (uri) => shell.openExternal(uri)
}

export function registerFirstRunIpc(): void {
  ipcMain.handle('firstrun:list', () => listChecks(probes))
  ipcMain.handle('firstrun:run', (_e, raw: unknown) => {
    const id = safeParse('firstrun:run', idSchema, raw)
    if (!id) return INVALID
    return runCheck(id, probes)
  })
  ipcMain.handle('firstrun:fix', (_e, raw: unknown) => {
    const id = safeParse('firstrun:fix', idSchema, raw)
    if (!id) return INVALID
    return fixCheck(id, probes)
  })
  ipcMain.handle('firstrun:complete', async () => {
    await patchConfig({ onboarding: { done: true } })
    console.log(`[first-run] setup completed (version ${app.getVersion()})`)
    return { ok: true }
  })
}
