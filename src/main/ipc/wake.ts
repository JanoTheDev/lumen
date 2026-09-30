import { ipcMain } from 'electron'
import { installModel, modelInstalled, modelRoot } from '../wake-model'

export function registerWakeIpc(): void {
  ipcMain.handle('wake:model-status', () => ({
    installed: modelInstalled(),
    path: modelRoot()
  }))
  ipcMain.handle('wake:model-install', async () => {
    try {
      await installModel()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
