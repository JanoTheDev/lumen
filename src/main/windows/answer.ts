// Top-right answer card.
import { screen, type BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'

const WIDTH = 360

let win: BrowserWindow | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  sendTo(win, channel, ...args)
}

export function create(): void {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  win = createWindow({
    width: WIDTH,
    height: 220,
    x: width - 376,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false
  })
  win.setIgnoreMouseEvents(false)

  loadRenderer(win, 'answeroverlay')
}

export function showText(text: string): void {
  send('answer:text', text)
  get()?.show()
}

export function hide(): void {
  get()?.hide()
}

export function resize(height: number): void {
  get()?.setSize(WIDTH, height)
}

registerWindow(get, { zoom: true, interactive: true })
