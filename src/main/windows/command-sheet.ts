// "What can I say" sheet (06 T21): a small focusable window listing every local voice
// command, the ones that apply right now first. Opened by voice ("what can I say", "help")
// or the a11y help shortcut. Escape or the close button hides it.
import { screen, type BrowserWindow } from 'electron'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'
import { themeBackground } from './settings'

const WIDTH = 560
const HEIGHT = 680

let win: BrowserWindow | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

function placement(): Electron.Rectangle {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(WIDTH, wa.width)
  const height = Math.min(HEIGHT, wa.height)
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width,
    height
  }
}

/** Opens the sheet (or brings it back with fresh context-aware rows). */
export function show(): void {
  const existing = get()
  if (existing) {
    sendTo(existing, 'a11y:sheet-refresh')
    existing.show()
    existing.focus()
    return
  }
  const w = createWindow({
    ...placement(),
    title: 'Lumen commands',
    frame: false,
    resizable: true,
    minWidth: 360,
    minHeight: 320,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: themeBackground(),
    show: false
  })
  win = w
  w.setAlwaysOnTop(true, 'floating')
  w.once('ready-to-show', () => {
    w.show()
    w.focus()
  })
  w.on('closed', () => {
    win = null
  })
  loadRenderer(w, 'a11y', '/commands')
}

export function hide(): void {
  get()?.close()
}

registerWindow(get, { zoom: true, interactive: true })
