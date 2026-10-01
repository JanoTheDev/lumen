// diag:* channels: export a diagnostics zip, open the logs folder, build facts for About.
import { app, ipcMain, shell } from 'electron'
import type { AppBuildInfo } from '@shared/channels'
import { isPortable } from '../first-run/portable'
import { exportDiagnostics } from './export'
import { logFileDir } from './log-file'

export function logsDir(): string {
  return logFileDir() ?? app.getPath('logs')
}

export function buildInfo(): AppBuildInfo {
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    portable: isPortable(),
    logsDir: logsDir()
  }
}

export async function openLogsFolder(): Promise<{ ok: boolean }> {
  const error = await shell.openPath(logsDir())
  return { ok: !error }
}

export function registerDiagnosticsIpc(): void {
  ipcMain.handle('diag:export', () => exportDiagnostics())
  ipcMain.handle('diag:open-logs', () => openLogsFolder())
  ipcMain.handle('diag:info', () => buildInfo())
}
