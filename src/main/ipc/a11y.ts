// a11y:* channels (06): the "what can I say" sheet, the dwell palette and the scan keyboard.
import { ipcMain } from 'electron'
import type {
  CommandSheetData,
  DwellPaletteButton,
  DwellPaletteState,
  ScanKeyboardState
} from '@shared/channels'
import { dwellPickSchema, keyboardKeySchema } from '@shared/ipc'
import { safeParse } from './validate'

export interface A11yIpcDeps {
  commands: () => CommandSheetData
  closeSheet: () => void
  dwellState: () => DwellPaletteState
  dwellPick: (pick: DwellPaletteButton) => void
  keyboardState: () => ScanKeyboardState
  keyboardKey: (id: string) => void
  toggleKeyboard: () => void
}

export function registerA11yIpc(deps: A11yIpcDeps): void {
  ipcMain.handle('a11y:commands', () => deps.commands())
  ipcMain.handle('a11y:dwell-state', () => deps.dwellState())
  ipcMain.on('a11y:sheet-close', () => deps.closeSheet())
  ipcMain.on('a11y:dwell-pick', (_e, raw: unknown) => {
    const pick = safeParse('a11y:dwell-pick', dwellPickSchema, raw)
    if (pick === 'keyboard') deps.toggleKeyboard()
    else if (pick) deps.dwellPick(pick)
  })
  ipcMain.handle('a11y:keyboard-state', () => deps.keyboardState())
  ipcMain.on('a11y:keyboard-key', (_e, raw: unknown) => {
    const id = safeParse('a11y:keyboard-key', keyboardKeySchema, raw)
    if (id) deps.keyboardKey(id)
  })
}
