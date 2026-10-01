// a11y:* channels (06): the "what can I say" sheet and the dwell palette.
import { ipcMain } from 'electron'
import type { CommandSheetData, DwellPaletteButton, DwellPaletteState } from '@shared/channels'
import { dwellPickSchema } from '@shared/ipc'
import { safeParse } from './validate'

export interface A11yIpcDeps {
  commands: () => CommandSheetData
  closeSheet: () => void
  dwellState: () => DwellPaletteState
  dwellPick: (pick: DwellPaletteButton) => void
}

export function registerA11yIpc(deps: A11yIpcDeps): void {
  ipcMain.handle('a11y:commands', () => deps.commands())
  ipcMain.handle('a11y:dwell-state', () => deps.dwellState())
  ipcMain.on('a11y:sheet-close', () => deps.closeSheet())
  ipcMain.on('a11y:dwell-pick', (_e, raw: unknown) => {
    const pick = safeParse('a11y:dwell-pick', dwellPickSchema, raw)
    if (pick) deps.dwellPick(pick)
  })
}
