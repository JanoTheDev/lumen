// Top-right answer card.
import { screen, type BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { live, registerWindow, sendTo } from './registry'
import * as assistant from './assistant'
import { uiV2 } from './ui-mode'

const WIDTH = 360

let win: BrowserWindow | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  if (uiV2()) {
    if (channel === 'answer:text') assistant.showAnswer(args[0] as string)
    else assistant.send(channel, ...args)
    return
  }
  sendTo(win, channel, ...args)
}

export function create(): void {
  if (uiV2()) return
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
  if (uiV2()) return assistant.showAnswer(text)
  send('answer:text', text)
  get()?.show()
}

export function hide(): void {
  if (uiV2()) return assistant.close()
  get()?.hide()
}

export function resize(height: number): void {
  get()?.setSize(WIDTH, height)
}

registerWindow(get, { zoom: true, interactive: true })
