// Full-screen click-through layer that draws the dwell-click progress ring.
import { app, screen, type BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { isOverOwnWindow, live, registerWindow, sendTo } from './registry'
import { loadConfig } from '../config'
import { physToLogical } from '../actions/coords'

let win: BrowserWindow | null = null
let lastRaise = 0

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(win, channel, ...args)
}

function forceTop(): void {
  const w = get()
  if (!w) return
  try {
    // Cycle + stack on Windows: toggling off then on with a high relative level
    // forces Windows to re-evaluate z-order above the taskbar's HWND_TOPMOST.
    w.setAlwaysOnTop(false)
    w.setAlwaysOnTop(true, 'screen-saver', 1)
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    w.moveTop()
  } catch {
    /* noop */
  }
}

export function create(): void {
  const { width, height } = screen.getPrimaryDisplay().bounds
  win = createWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: false,
    hasShadow: false
  })
  win.setIgnoreMouseEvents(true, { forward: false })

  win.webContents.once('did-finish-load', () => {
    const w = get()
    if (w && loadConfig().dwellClick.enabled) {
      w.showInactive()
      forceTop()
    }
  })
  // Re-apply each time the app gains focus (OS sometimes resets z-order)
  app.on('browser-window-focus', () => forceTop())

  loadRenderer(win, 'dwellring')
}

export function setEnabled(enabled: boolean): void {
  const w = get()
  if (!w) return
  if (!enabled) w.hide()
  else if (!w.isVisible()) w.showInactive()
}

/** Forwards agent dwell progress (physical px) to the ring, which draws in logical px. */
export function progress(data: Record<string, unknown> | undefined): void {
  const w = get()
  if (!w) return
  const xPhys = data?.x
  const yPhys = data?.y
  if (typeof xPhys !== 'number' || typeof yPhys !== 'number') return
  const pt = physToLogical({ x: xPhys, y: yPhys })
  if (isOverOwnWindow(pt)) return
  // Re-raise at most every 2s so the ring stays above the taskbar without churning z-order.
  const now = Date.now()
  if (now - lastRaise > 2000) {
    lastRaise = now
    try {
      w.moveTop()
    } catch {
      /* noop */
    }
  }
  send('screen:dwell', {
    ...(data as { progress: number; active: boolean }),
    x: Math.round(pt.x),
    y: Math.round(pt.y)
  })
}

registerWindow(get)
