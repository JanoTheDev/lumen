import { ipcMain } from 'electron'
import { configPatchSchema } from '@shared/config'
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

export function broadcastConfig(cfg: AppConfig): void {
  broadcast('settings:changed', cfg as unknown as Record<string, unknown>)
  applyUiScale(cfg.a11y.uiScale)
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  ipcMain.handle('settings:get', () => loadConfig())
  ipcMain.handle('settings:patch', async (_e, raw: unknown) => {
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
    return next
  })

  ipcMain.on('settings:open', () => settingsWin.create())
  ipcMain.on('settings:window-close', () => settingsWin.close())
  ipcMain.on('settings:window-minimize', () => settingsWin.minimize())
  ipcMain.on('settings:window-maximize', () => settingsWin.toggleMaximize())
}
