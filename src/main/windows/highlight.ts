// Full-screen click-through layer for guide highlights, locate boxes and the pointer.
import { screen, type BrowserWindow } from 'electron'
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
    show: false
  })
  win.setIgnoreMouseEvents(true)

  loadRenderer(win, 'highlight')
}

export function show(): void {
  get()?.show()
}

export function hide(): void {
  get()?.hide()
}

export function isVisible(): boolean {
  return !!get()?.isVisible()
}

/** Hides the layer and drops everything drawn on it. */
export function clear(): void {
  hide()
  send('screen:clear')
}

registerWindow(get)
