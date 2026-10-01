// Settings → cost estimate: model spend today, this session and per day over the last 30 days.
import { app, ipcMain } from 'electron'
import { usageOverview } from '../ai/cost'
import { enableUsageLog, flushUsage } from '../ai/usage-log'

export function registerUsageIpc(): void {
  enableUsageLog()
  ipcMain.handle('usage:get', () => usageOverview())
  app.on('before-quit', () => flushUsage())
}
