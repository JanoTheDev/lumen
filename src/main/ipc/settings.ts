import { ipcMain } from 'electron'
import { z } from 'zod'
import { configPatchSchema } from '@shared/config'
import { PROFILE_IDS, profilePatch } from '@shared/profiles'
import { INVALID, safeParse } from './validate'
import { loadConfig, saveConfig, type AppConfig } from '../config'
import { log } from '../logger'
import { applyUiScale, broadcast } from '../windows/registry'
import { hideStatus } from '../windows/status'
import * as settingsWin from '../windows/settings'

export interface SettingsIpcDeps {
  setHotkey: (combo: string) => Promise<unknown>
  applyDictationHotkey: (cfg: AppConfig) => Promise<void>
  applyListenerState: (cfg: AppConfig) => void
  applyDwellState: (cfg: AppConfig) => void
}

const profileIdsSchema = z.array(z.enum(PROFILE_IDS)).max(PROFILE_IDS.length)

export function broadcastConfig(cfg: AppConfig): void {
  broadcast('settings:changed', cfg as unknown as Record<string, unknown>)
  applyUiScale(cfg.a11y.uiScale)
}

let deps: SettingsIpcDeps | null = null

/**
 * Validates and saves a settings patch, then re-applies whatever it changed (hotkeys,
 * listeners, dwell). Shared by settings:patch, profiles and the tray menu.
 */
export async function patchConfig(raw: unknown): Promise<AppConfig | typeof INVALID> {
  const patch = safeParse('settings:patch', configPatchSchema, raw)
  if (!patch) return INVALID
  const prev = loadConfig()
  let next: AppConfig
  try {
    next = saveConfig(patch as Partial<AppConfig>)
  } catch (e) {
    log('fail', `config save rejected: ${(e as Error).message}`)
    return INVALID
  }
  broadcastConfig(next)
  if (!deps) return next
  if (patch.hotkey && patch.hotkey !== prev.hotkey) {
    try {
      await deps.setHotkey(next.hotkey)
    } catch (e) {
      console.error('[hotkey] rebind failed:', (e as Error).message)
    }
  }
  const dictationKey = (c: AppConfig): string =>
    JSON.stringify([c.hotkey, c.dictation.enabled, c.dictation.hotkey])
  if (dictationKey(prev) !== dictationKey(next)) await deps.applyDictationHotkey(next)
  if (patch.statusBubble && prev.statusBubble.enabled && !next.statusBubble.enabled) {
    hideStatus()
  }
  // Only touch the agent when the relevant settings actually changed.
  const listenerChanged =
    JSON.stringify([prev.wakeWord, prev.cancelVoice]) !==
    JSON.stringify([next.wakeWord, next.cancelVoice])
  if (listenerChanged) deps.applyListenerState(next)
  if (JSON.stringify(prev.dwellClick) !== JSON.stringify(next.dwellClick))
    deps.applyDwellState(next)
  for (const fn of listeners) fn(next, prev)
  return next
}

type ConfigListener = (next: AppConfig, prev: AppConfig) => void
const listeners = new Set<ConfigListener>()

/** Called after every saved patch (tray state, home shortcut). Returns the unsubscribe. */
export function onConfigPatched(fn: ConfigListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function registerSettingsIpc(d: SettingsIpcDeps): void {
  deps = d
  ipcMain.handle('settings:get', () => loadConfig())
  ipcMain.handle('settings:patch', (_e, raw: unknown) => patchConfig(raw))
  ipcMain.handle('a11y:apply-profile', (_e, raw: unknown) => {
    const ids = safeParse('a11y:apply-profile', profileIdsSchema, raw)
    if (!ids) return INVALID
    return patchConfig(profilePatch(loadConfig(), ids))
  })

  ipcMain.on('settings:open', () => settingsWin.create())
  ipcMain.on('settings:window-close', () => settingsWin.close())
  ipcMain.on('settings:window-minimize', () => settingsWin.minimize())
  ipcMain.on('settings:window-maximize', () => settingsWin.toggleMaximize())
}
