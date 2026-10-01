import { ipcMain, shell } from 'electron'
import { assertSafeUrl, isSafeUrl } from '../actions/safety'
import { log } from '../logger'
import * as assistant from '../windows/assistant'

export interface HudIpcDeps {
  armEscape: () => void
  disarmEscape: () => void
}

export function registerHudIpc(deps: HudIpcDeps): void {
  ipcMain.on('assistant:close', () => {
    deps.disarmEscape()
    assistant.turnEnded()
    assistant.settle()
  })
  ipcMain.on('assistant:show', () => {
    deps.armEscape()
    assistant.open('listening')
  })
  ipcMain.on('assistant:open-link', (_e, url: unknown) => {
    if (!isSafeUrl(url)) {
      log('fail', `blocked link: ${String(url).slice(0, 200)}`)
      return
    }
    shell.openExternal(assertSafeUrl(url)).catch(() => {})
  })
}
