// Home flyout: the panel entry at #/home in a small window anchored to the tray icon.
// Created hidden at startup so opening it is instant; closes on blur or Escape.
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { clampScale, live, registerWindow, sendTo } from './registry'
import { loadConfig } from '../config'
import { themeBackground } from './settings'

const WIDTH_CSS = 352
const HEIGHT_CSS = 520
const GAP = 12

let win: BrowserWindow | null = null
let shownAt = 0
let blurredAt = 0

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(win, channel, ...args)
}

/** Above the tray icon when its rect is known, else the bottom-right of the work area. */
export function anchorBounds(
  anchor: Rectangle | null,
  workArea: Rectangle,
  size: { width: number; height: number }
): Rectangle {
  const { width, height } = size
  let x = workArea.x + workArea.width - width - GAP
  let y = workArea.y + workArea.height - height - GAP
  if (anchor && anchor.width > 0) {
    x = Math.round(anchor.x + anchor.width / 2 - width / 2)
    // Taskbar at the top: open below the icon.
    y =
      anchor.y < workArea.y + workArea.height / 2
        ? anchor.y + anchor.height + GAP
        : anchor.y - height - GAP
  }
  x = Math.max(workArea.x + GAP, Math.min(x, workArea.x + workArea.width - width - GAP))
  y = Math.max(workArea.y + GAP, Math.min(y, workArea.y + workArea.height - height - GAP))
  return { x, y, width, height }
}

export function create(): void {
  win = createWindow({
    width: WIDTH_CSS,
    height: HEIGHT_CSS,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Lumen',
    backgroundColor: themeBackground()
  })
  win.on('blur', () => {
    // A blur right after opening comes from the tray click itself.
    if (Date.now() - shownAt > 250) {
      blurredAt = Date.now()
      hide()
    }
  })
  loadRenderer(win, 'panel', '/home')
}

export function show(anchor: Rectangle | null = null): void {
  const w = get()
  if (!w) return
  const point = anchor ? { x: anchor.x, y: anchor.y } : screen.getCursorScreenPoint()
  const d = screen.getDisplayNearestPoint(point)
  // The panel entry scales its own root font, so the window grows with uiScale too.
  const zoom = clampScale(loadConfig().a11y.uiScale)
  const size = {
    width: Math.round(WIDTH_CSS * zoom),
    height: Math.min(Math.round(HEIGHT_CSS * zoom), Math.round(d.workArea.height * 0.8))
  }
  w.setBounds(anchorBounds(anchor, d.workArea, size))
  shownAt = Date.now()
  w.show()
  w.focus()
  send('home:shown')
}

export function hide(): void {
  get()?.hide()
}

export function toggle(anchor: Rectangle | null = null): void {
  const w = get()
  if (w?.isVisible()) hide()
  // Clicking the tray icon while Home is open blurs it first; that click means "close".
  else if (Date.now() - blurredAt > 300) show(anchor)
}

registerWindow(get, { interactive: true })
