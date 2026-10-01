import { ipcMain } from 'electron'
import { loadConfig } from '../config'
import { loadSherpa } from '../speech/sherpa'
import { applyWakeState, ENGINE_UNAVAILABLE, wakeStatus } from '../speech/wake'
import { installKwsModel } from '../speech/wake/kws-model'

/** Installs the keyword spotter model; fails when the engine itself cannot load here. */
export async function installWakeModel(): Promise<void> {
  if (!loadSherpa()) throw new Error(ENGINE_UNAVAILABLE)
  await installKwsModel()
  applyWakeState(loadConfig())
}

export function registerWakeIpc(): void {
  ipcMain.handle('wake:model-status', () => wakeStatus())
  ipcMain.handle('wake:model-install', async () => {
    try {
      await installWakeModel()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
