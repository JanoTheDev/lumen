// Wires UpdateService to Electron, the config switch and the update:* IPC channels.
import { app, ipcMain, net } from 'electron'
import { loadConfig } from '../config'
import { isPortable } from '../first-run/portable'
import { onConfigPatched } from '../ipc/settings'
import { updateMode } from './policy'
import { UpdateService, type UpdaterLike } from './service'

const FETCH_TIMEOUT_MS = 15_000

async function fetchText(url: string): Promise<string> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

let service: UpdateService | null = null

export function installUpdates(): void {
  if (service) return
  const s = new UpdateService({
    mode: updateMode(app.isPackaged, isPortable()),
    currentVersion: app.getVersion(),
    enabled: () => loadConfig().system.autoUpdate,
    isOnline: () => net.isOnline(),
    // Loaded only when an installed build checks, so dev and portable never construct it.
    loadUpdater: async () => (await import('electron-updater')).autoUpdater as UpdaterLike,
    fetchText,
    log: (m) => console.log(m)
  })
  service = s
  ipcMain.handle('update:status', () => s.status())
  ipcMain.handle('update:check', () => s.check(true))
  ipcMain.handle('update:install', () => s.install())
  onConfigPatched(() => s.applyEnabled())
  s.start()
}
