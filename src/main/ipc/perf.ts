// perf:last-turn (10 T11b): the last turn's stage timings for Settings → Diagnostics.
import { ipcMain } from 'electron'
import { lastTurn } from '../ai/turn-metrics'

export function registerPerfIpc(): void {
  ipcMain.handle('perf:last-turn', () => lastTurn())
}
