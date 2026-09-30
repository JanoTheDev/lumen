// Settings window, opened from the tray or the HUD.
import type { BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'

let win: BrowserWindow | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(win, channel, ...args)
}

/** Opens the settings window, or focuses it when already open. */
export function create(): void {
  const existing = get()
  if (existing) {
    existing.focus()
    return
  }
  const w = createWindow({
    width: 860,
    height: 620,
    minWidth: 720,
    minHeight: 520,
    title: 'Lumen Settings',
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0b10',
    resizable: true,
    show: false
  })
  win = w
  w.once('ready-to-show', () => w.show())
  loadRenderer(w, 'settings')
  w.on('closed', () => {
    win = null
  })
}

export function close(): void {
  get()?.close()
}

export function minimize(): void {
  get()?.minimize()
}

export function toggleMaximize(): void {
  const w = get()
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
}

registerWindow(get, { interactive: true })
