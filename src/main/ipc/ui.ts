// Channels of the v2 surfaces: assistant bar commands, screen layer capture, panel + home.
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { z } from 'zod'
import { promptSchema } from '@shared/ipc'
import type { HomeInfo } from '@shared/channels'
import { safeParse } from './validate'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { getAgent } from '../agent/instance'
import { activeWindow } from '../agent/commands'
import { agentCommand, agentRunning, hasPausedTask } from '../agent-mode/session'
import { confirmAlways } from '../agent-mode/confirm'
import { screenReaderActive } from '../a11y/at-state'
import { reportError } from '../a11y/live-feedback'
import { openEditor, submitEdit } from '../a11y/transcript'
import { announce } from '../a11y'
import * as assistant from '../windows/assistant'
import * as layer from '../windows/screen-layer'
import * as settingsWin from '../windows/settings'
import * as home from '../windows/home'

const commandSchema = z
  .object({
    type: z.enum([
      'repeat',
      'pin',
      'close',
      'copy',
      'cancel',
      'confirm',
      'confirm-always',
      'deny',
      'unmute',
      'undo',
      'edit',
      'edit-cancel',
      'retry',
      'go',
      'answer',
      'help',
      'leave'
    ]),
    turnId: z.string().max(64).optional(),
    step: z.number().int().min(1).max(1000).optional(),
    text: z.string().trim().min(1).max(200).optional()
  })
  .strict()

type BarCommand = z.infer<typeof commandSchema>

/** The phrase the pipeline resumes a paused agent task with (agent-mode RESUME_RE). */
const RESUME_PROMPT = 'resume the task'

/**
 * Agent step list buttons (08 T13). Start now and the question's choices go to the running
 * task. Retry has no step-level path in the runner yet: a paused task resumes, else the
 * request runs again from the start. Returns false for every other command.
 */
export function agentBarCommand(
  cmd: BarCommand,
  run: (prompt: string) => void,
  task = assistant.state().agentTask
): boolean {
  switch (cmd.type) {
    case 'go':
      agentCommand({ type: 'go' })
      return true
    case 'answer':
      if (cmd.text) agentCommand({ type: 'answer', text: cmd.text })
      return true
    case 'retry': {
      if (agentRunning()) return true
      const prompt = hasPausedTask() ? RESUME_PROMPT : task?.prompt
      if (prompt) run(prompt)
      return true
    }
    default:
      return false
  }
}
const errorSchema = z.string().trim().min(1).max(500)
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
// settings/<section>, and settings/buddies/<id or _new> for one buddy's page (08 T53).
const routeSchema = z
  .string()
  .regex(/^(settings(\/[a-z-]{1,32}(\/[a-z0-9_-]{1,40})?)?|onboarding|home)$/)

const TRY_ANNOUNCE = 'This is how Lumen tells you what it is doing.'
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
  assistant.setCommandDeps({ cancel: deps.cancel, edit: openEditor })
  // Focused mode: the window to give focus back to, found and refocused by the agent.
  assistant.setForegroundIo({
    current: async () => {
      const a = getAgent()
      return a ? (await activeWindow(a, { timeoutMs: 250 })).hwnd || null : null
    },
    focus: async (hwnd) => getAgent()?.request('focus_window', { hwnd }, { timeoutMs: 1000 })
  })
  const runQuery = (prompt: string): void => assistant.send('assistant:run-query', prompt)

  ipcMain.on('assistant:command', (_e, raw: unknown) => {
    const cmd = safeParse('assistant:command', commandSchema, raw)
    if (!cmd) return
    // Always on a card without a grant scope (or one already answered) is a plain confirm.
    if (cmd.type === 'confirm-always') {
      if (!confirmAlways()) assistant.command({ ...cmd, type: 'confirm' })
    } else if (!agentBarCommand(cmd, runQuery)) assistant.command(cmd)
  })
  ipcMain.on('assistant:error', (_e, raw: unknown) => {
    const message = safeParse('assistant:error', errorSchema, raw)
    if (message) reportError(message)
  })
  ipcMain.on('assistant:correct', (_e, raw: unknown) => {
    const text = safeParse('assistant:correct', promptSchema, raw)
    if (text) submitEdit(text)
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
  ipcMain.on('a11y:try', (_e, raw: unknown) => {
    if (raw === 'announce') announce(TRY_ANNOUNCE, { kind: 'status', priority: 'assertive' })
  })

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
    assistant.send('assistant:run-query', text)
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
