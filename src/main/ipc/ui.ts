// Channels of the v2 surfaces: assistant bar commands, screen layer capture, panel + home.
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { z } from 'zod'
import { promptSchema } from '@shared/ipc'
import type { HomeInfo } from '@shared/channels'
import { safeParse } from './validate'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { getAgent } from '../agent/instance'
import { screenReaderActive } from '../a11y/at-state'
import * as assistant from '../windows/assistant'
import * as layer from '../windows/screen-layer'
import * as settingsWin from '../windows/settings'
import * as home from '../windows/home'
import * as hud from '../windows/hud'

const commandSchema = z
  .object({
    type: z.enum(['repeat', 'pin', 'close', 'copy', 'cancel', 'confirm', 'deny']),
    turnId: z.string().max(64).optional()
  })
  .strict()
const sizeSchema = z.object({
  w: z.number().finite().min(0).max(10_000),
  h: z.number().finite().min(0).max(10_000)
})
const point = z.object({ x: z.number().finite(), y: z.number().finite() })
const drawingSchema = z.object({
  points: z.array(point).max(5000),
  rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite(),
    h: z.number().finite()
  })
})
const routeSchema = z.string().regex(/^(settings(\/[a-z-]{1,32})?|onboarding|home)$/)

const RECENT_MAX = 5
const recent: string[] = []

/** User prompts for Home's Recent list; follow-ups the pipeline sends itself are skipped. */
function remember(prompt: string): void {
  if (!loadConfig().historyEnabled || prompt.startsWith('The page is loaded')) return
  const i = recent.indexOf(prompt)
  if (i >= 0) recent.splice(i, 1)
  recent.unshift(prompt)
  recent.length = Math.min(recent.length, RECENT_MAX)
}

export interface UiIpcDeps {
  cancel: () => void
  /** Called with a stroke the user drew in capture mode (global logical px). */
  onUserDrawing?: (d: {
    points: { x: number; y: number }[]
    rect: { x: number; y: number; w: number; h: number }
  }) => void
}

export function registerUiIpc(deps: UiIpcDeps): void {
  let agentReady = false
  getAgent()?.onEvent('agent-ready', () => (agentReady = true))
  getAgent()?.onEvent('agent-down', () => (agentReady = false))
  bus.on('query.started', (e) => remember(e.prompt))
  assistant.setCommandDeps({ cancel: deps.cancel })

  ipcMain.on('assistant:command', (_e, raw: unknown) => {
    const cmd = safeParse('assistant:command', commandSchema, raw)
    if (cmd) assistant.command(cmd)
  })
  ipcMain.on('assistant:resize', (_e, raw: unknown) => {
    const size = safeParse('assistant:resize', sizeSchema, raw)
    if (size) assistant.setCard(size)
  })
  ipcMain.on('assistant:interactive', (_e, raw: unknown) => {
    assistant.setInteractive(raw === true)
  })

  ipcMain.on('screen:user-drawing', (e: IpcMainEvent, raw: unknown) => {
    const d = safeParse('screen:user-drawing', drawingSchema, raw)
    if (!d) return
    const win = BrowserWindow.fromWebContents(e.sender)
    const points = d.points.map((p) => layer.toGlobal(win, p))
    const o = layer.toGlobal(win, d.rect)
    deps.onUserDrawing?.({ points, rect: { ...d.rect, x: o.x, y: o.y } })
  })
  ipcMain.on('screen:capture-end', () => layer.setCapture(false))

  ipcMain.on('panel:open', (_e, raw: unknown) => {
    const route = safeParse('panel:open', routeSchema, raw)
    if (!route) return
    if (route === 'home') home.show()
    else {
      home.hide()
      settingsWin.create(route)
    }
  })
  ipcMain.on('panel:close', (e: IpcMainEvent) => {
    if (home.get()?.webContents === e.sender) home.hide()
    else if (settingsWin.get()?.webContents === e.sender) settingsWin.close()
  })
  ipcMain.on('home:run', (_e, raw: unknown) => {
    const text = safeParse('home:run', promptSchema, raw)
    if (!text) return
    home.hide()
    hud.send('assistant:run-query', text)
  })
  ipcMain.handle('onboarding:info', () => ({ screenReader: screenReaderActive() }))
  ipcMain.handle('home:info', (): HomeInfo => {
    const cfg = loadConfig()
    return {
      hotkey: cfg.hotkey,
      agentReady,
      wakeWord: cfg.wakeWord.enabled,
      dwell: cfg.dwellClick.enabled,
      buddy: cfg.buddy.enabled,
      recent: cfg.historyEnabled ? [...recent] : []
    }
  })
}
