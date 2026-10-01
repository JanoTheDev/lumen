// App bridge IPC (07 T23–T26): status and test for Settings → App helpers, the Blender add-on
// file, and the OBS WebSocket password. The password never goes back to the renderer.
import { ipcMain } from 'electron'
import { bridgeIdSchema, obsBridgeSchema } from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import {
  allBridgeStatus,
  bridgeStatus,
  clearObsSettings,
  revealBlenderAddon,
  setObsSettings
} from '../teach/bridges'

export function registerBridgesIpc(): void {
  ipcMain.handle('bridges:status', () => allBridgeStatus())
  ipcMain.handle('bridges:test', (_e, raw: unknown) => {
    const id = safeParse('bridges:test', bridgeIdSchema, raw)
    if (!id) return INVALID
    return bridgeStatus(id)
  })
  ipcMain.handle('bridges:blender-addon', () => revealBlenderAddon())
  ipcMain.handle('bridges:obs-set', (_e, raw: unknown) => {
    const req = safeParse('bridges:obs-set', obsBridgeSchema, raw)
    if (!req) return INVALID
    return setObsSettings(req)
  })
  ipcMain.handle('bridges:obs-clear', () => ({ ok: clearObsSettings() }))
}
