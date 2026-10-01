// "What can I say" (06 T21): the sheet's rows and its global shortcut (a11y.helpHotkey).
import { globalShortcut } from 'electron'
import type { CommandSheetData } from '@shared/channels'
import { loadConfig } from '../config'
import { log } from '../logger'
import { onConfigPatched } from '../ipc/settings'
import * as sheet from '../windows/command-sheet'
import { commandSheetRows, type CommandContext } from './voice-commands'

export function commandSheetData(ctx: CommandContext, hotkey: string): CommandSheetData {
  return { rows: commandSheetRows(ctx), hotkey }
}

let bound = ''

function bind(hotkey: string): void {
  if (hotkey === bound) return
  if (bound) globalShortcut.unregister(bound)
  bound = ''
  if (!hotkey) return
  try {
    if (globalShortcut.register(hotkey, () => sheet.show())) bound = hotkey
    else log('skip', `help shortcut ${hotkey} is taken by another app`)
  } catch (e) {
    log('fail', `help shortcut ${hotkey} rejected (${(e as Error).message})`)
  }
}

/** Binds the help shortcut now and whenever settings change it. */
export function installHelpShortcut(): void {
  bind(loadConfig().a11y.helpHotkey ?? '')
  onConfigPatched((next) => bind(next.a11y.helpHotkey ?? ''))
}

/** The shortcut actually bound ("" when none or it failed). */
export function helpShortcut(): string {
  return bound
}
