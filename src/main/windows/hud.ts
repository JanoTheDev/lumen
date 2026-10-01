// Push-to-talk HUD. Kept loaded and toggled by opacity so the renderer keeps recording.
import { screen, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'
import { bus } from '../bus'
import * as assistant from './assistant'
import { uiV2 } from './ui-mode'

let win: BrowserWindow | null = null

// With ui v2 the assistant window hosts the voice renderer, so every HUD call goes there.
export function get(): BrowserWindow | null {
  return uiV2() ? assistant.get() : live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(get(), channel, ...args)
}

export function create(): void {
  if (uiV2()) return
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const w = 100
  const h = 44

  win = createWindow({
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: height - h - 32,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: true
  })
  // Start invisible — use opacity instead of hide/show so Chromium never
  // suspends the renderer (which pauses audio tracks and kills recording)
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)

  win.webContents.on('did-finish-load', () => {
    if (is.dev) win?.webContents.openDevTools({ mode: 'detach' })
  })

  loadRenderer(win, 'index')
}

export function show(): void {
  if (uiV2()) return assistant.open('listening')
  get()?.setOpacity(1)
  get()?.setIgnoreMouseEvents(false)
}

export function hide(): void {
  if (uiV2()) return assistant.turnEnded()
  get()?.setOpacity(0)
  get()?.setIgnoreMouseEvents(true)
}

/** Hands-free uses the same auto-stop-on-silence path as wake-word activation. */
export function startVoice(handsFree: boolean): void {
  send('voice:start', { mode: handsFree ? 'hands-free' : 'hold' })
}

export function startDictation(): void {
  send('voice:start', { mode: 'dictation' })
}

export function dictationHandsFree(): void {
  send('voice:hands-free')
}

export function stopVoice(): void {
  send('voice:stop')
}

registerWindow(get, { zoom: true, interactive: true })

bus.on('voice.started', (e) => {
  show()
  startVoice(e.handsFree)
})
bus.on('dictation.started', () => {
  show()
  startDictation()
})
bus.on('dictation.hands-free', () => dictationHandsFree())
bus.on('voice.stopped', () => stopVoice())
bus.on('voice.cancelled', () => send('assistant:cancel-request'))
