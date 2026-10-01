import { ipcMain } from 'electron'
import { installModel, modelInstalled, modelRoot } from '../wake-model'
import { loadConfig } from '../config'
import { loadSherpa } from '../speech/sherpa'
import { applyWakeState } from '../speech/wake'
import { installKwsModel, kwsModelDir, kwsModelInstalled } from '../speech/wake/kws-model'

// The wake model is the keyword spotter's; the Vosk model only where the native engine is missing.
export function registerWakeIpc(): void {
  ipcMain.handle('wake:model-status', () =>
    loadSherpa()
      ? { installed: kwsModelInstalled(), path: kwsModelDir() }
      : { installed: modelInstalled(), path: modelRoot() }
  )
  ipcMain.handle('wake:model-install', async () => {
    try {
      if (loadSherpa()) {
        await installKwsModel()
        applyWakeState(loadConfig())
      } else {
        await installModel()
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
