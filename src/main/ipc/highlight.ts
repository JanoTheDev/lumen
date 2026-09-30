import { ipcMain } from 'electron'
import * as highlight from '../windows/highlight'

export function registerHighlightIpc(): void {
  ipcMain.handle('screen:hide', () => {
    highlight.clear()
  })
}
