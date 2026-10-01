// Full-screen click-through layer for guide highlights, locate boxes and the pointer.
import { screen, type BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import type { GuideStep, LocateItem, Point } from '@shared/types'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'
import * as layer from './screen-layer'
import { uiV2 } from './ui-mode'

let win: BrowserWindow | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  if (uiV2()) return toLayer(channel, args)
  sendTo(win, channel, ...args)
}

// The old highlight events, redrawn as one scene on the per-display screen layer.
function toLayer(channel: EventChannel, args: unknown[]): void {
  if (channel === 'screen:highlights') layer.setHighlights(args[0] as GuideStep[])
  else if (channel === 'screen:pointer') layer.setPointer(args[0] as Point & { text: string })
  else if (channel === 'screen:locate') layer.setLocate(args[0] as LocateItem[])
  else if (channel === 'screen:clear') layer.clear()
}

export function create(): void {
  if (uiV2()) return
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
  if (uiV2()) return layer.show()
  get()?.show()
}

export function hide(): void {
  if (uiV2()) return layer.hide()
  get()?.hide()
}

export function isVisible(): boolean {
  if (uiV2()) return layer.isVisible()
  return !!get()?.isVisible()
}

/** Hides the layer and drops everything drawn on it. */
export function clear(): void {
  if (uiV2()) return layer.clear()
  hide()
  send('screen:clear')
}

registerWindow(get)
