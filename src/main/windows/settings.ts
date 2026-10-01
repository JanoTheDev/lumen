// Panel window: settings and onboarding (ui v2 loads the panel entry; v1 the settings entry).
import { nativeTheme, type BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'
import { uiV2 } from './ui-mode'
import { loadConfig } from '../config'

let win: BrowserWindow | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(win, channel, ...args)
}

/** Window background before the renderer paints (theme --bg), so Light does not flash dark. */
export function themeBackground(): string {
  const t = loadConfig().theme
  const light = t === 'light' || (t === 'system' && !nativeTheme.shouldUseDarkColors)
  if (t === 'high-contrast' || nativeTheme.shouldUseHighContrastColors) return '#000000'
  return light ? '#F3F4F6' : '#111318'
}

/**
 * Opens the panel at `route` ("settings", "settings/voice", "onboarding"), or switches the
 * open one to it.
 */
export function create(route = 'settings'): void {
  const existing = get()
  if (existing) {
    send('panel:route', route)
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  const w = createWindow({
    width: 860,
    height: 620,
    minWidth: 720,
    minHeight: 520,
    title: 'Lumen',
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: themeBackground(),
    resizable: true,
    show: false
  })
  win = w
  w.once('ready-to-show', () => w.show())
  if (uiV2()) loadRenderer(w, 'panel', `/${route}`)
  else loadRenderer(w, 'settings', `/${route}`)
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
