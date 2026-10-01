// Status bubble above the HUD: listening / thinking / step n of m / errors.
import { screen, type BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'
import { loadConfig } from '../config'
import * as assistant from './assistant'
import { statusHoldMs } from '../a11y/timings'
import { uiV2 } from './ui-mode'

export type StatusKind =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'acting'
  | 'answer'
  | 'error'
  | 'step'

let win: BrowserWindow | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(win, channel, ...args)
}

export function create(): void {
  if (uiV2()) return
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const w = 420
  const h = 44

  win = createWindow({
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: height - h - 78,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: false,
    hasShadow: false
  })
  win.setIgnoreMouseEvents(true)

  loadRenderer(win, 'status')
}

export function setStatus(
  kind: StatusKind,
  text: string,
  step?: { index: number; total: number },
  requestedHideMs?: number
): void {
  // Timed lines stay at least a11y.timings.statusHoldMs (WCAG 2.2.1).
  const autoHideMs = statusHoldMs(loadConfig(), requestedHideMs)
  if (uiV2()) return assistant.status(kind, text, step, autoHideMs)
  if (!loadConfig().statusBubble.enabled) return
  const w = get()
  if (!w) return
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  w.showInactive()
  send('status:set', { kind, text, step })
  if (autoHideMs && autoHideMs > 0) {
    hideTimer = setTimeout(() => hideStatus(), autoHideMs)
  }
}

export function hideStatus(): void {
  if (uiV2()) return assistant.settle()
  if (!get()) return
  send('status:hide')
  // Tracked so a setStatus during the fade-out cancels the hide.
  hideTimer = setTimeout(() => {
    hideTimer = null
    get()?.hide()
  }, 220)
}

registerWindow(get, { zoom: true, interactive: true })
