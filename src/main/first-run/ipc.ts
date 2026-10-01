// firstrun:* channels for the setup flow, wired to the real probes.
import { app, ipcMain, shell, systemPreferences } from 'electron'
import { execFile } from 'child_process'
import { z } from 'zod'
import { INVALID, safeParse } from '../ipc/validate'
import { loadConfig } from '../config'
import { getAgent } from '../agent/instance'
import type { AgentBridge } from '../agent/bridge'
import { ocr } from '../agent/commands'
import { KEY_PROVIDERS, hasKey } from '../keys/vault'
import { installWakeModel } from '../ipc/wake'
import { patchConfig } from '../ipc/settings'
import { wakeStatus } from '../speech/wake'
import { CHECK_IDS, fixCheck, listChecks, runCheck, type CheckProbes } from './checks'

const idSchema = z.enum(CHECK_IDS)

// One hotkey-down listener per bridge; waiters resolve on the next press.
const hooked = new WeakSet<AgentBridge>()
const hotkeyWaiters = new Set<() => void>()

function waitForHotkey(ms: number): Promise<boolean> {
  const agent = getAgent()
  if (!agent) return Promise.resolve(false)
  if (!hooked.has(agent)) {
    hooked.add(agent)
    agent.onEvent('hotkey-down', () => {
      for (const w of [...hotkeyWaiters]) w()
    })
  }
  return new Promise((resolve) => {
    const done = (pressed: boolean): void => {
      clearTimeout(timer)
      hotkeyWaiters.delete(onPress)
      resolve(pressed)
    }
    const onPress = (): void => done(true)
    const timer = setTimeout(() => done(false), ms)
    hotkeyWaiters.add(onPress)
  })
}

let elevatedCache: boolean | null = null

/** High mandatory level (S-1-16-12288) in the process token = running as administrator. */
function elevated(): Promise<boolean> {
  if (elevatedCache !== null) return Promise.resolve(elevatedCache)
  if (process.platform !== 'win32') return Promise.resolve(false)
  const whoami = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\whoami.exe`
  return new Promise((resolve) => {
    execFile(whoami, ['/groups'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      elevatedCache = !err && /S-1-16-12288/.test(stdout)
      resolve(elevatedCache)
    })
  })
}

const probes: CheckProbes = {
  keyProviders: () => KEY_PROVIDERS.filter((p) => hasKey(p)),
  localMode: () => loadConfig().models.provider === 'local',
  micAccess: () =>
    process.platform === 'win32' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
  agent: () => {
    const a = getAgent()
    if (!a) return null
    return { running: a.running, impl: a.impl, version: a.version, fallback: a.implFallback }
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
      // The helper itself can't do OCR (old protocol): not a missing language pack.
      if (err.code === 'E_UNSUPPORTED' && /protocol|unsupported by/.test(err.message)) {
        throw new Error('this helper cannot read the screen')
      }
      throw err
    }
  },
  wakeEnabled: () => loadConfig().wakeWord.enabled,
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
