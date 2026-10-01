// Scan keyboard (06 T10): an on-screen keyboard docked at the bottom of the primary display.
// Like the dwell palette it never takes focus, so keys typed through the agent reach the app
// the user was in; mouse and dwell clicks on it land as plain clicks. Switch scanning drives
// its highlight through a11y:keyboard-state.
import { screen, type BrowserWindow } from 'electron'
import type { ScanKeyboardState } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { clampScale, live, registerWindow, sendTo } from './registry'
import { themeBackground } from './settings'
import { loadConfig } from '../config'
import { effectiveScale } from '../a11y/text-scale'

const WIDTH = 820
const HEIGHT = 340
const EDGE_GAP = 8

let win: BrowserWindow | null = null
let last: ScanKeyboardState | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

function placement(): Electron.Rectangle {
  const wa = screen.getPrimaryDisplay().workArea
  const scale = clampScale(effectiveScale(loadConfig().a11y.uiScale))
  const width = Math.min(Math.round(WIDTH * scale), wa.width)
  const height = Math.min(Math.round(HEIGHT * scale), Math.round(wa.height / 2))
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: wa.y + wa.height - height - EDGE_GAP,
    width,
    height
  }
}

function create(): BrowserWindow {
  const w = createWindow({
    ...placement(),
    title: 'Lumen keyboard',
    frame: false,
    resizable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: themeBackground(),
    show: false
  })
  win = w
  w.setAlwaysOnTop(true, 'screen-saver')
  w.once('ready-to-show', () => w.showInactive())
  w.webContents.on('did-finish-load', () => {
    // Created after start-up, so the broadcast zoom never reached it: apply it on load.
    w.webContents.setZoomFactor(clampScale(effectiveScale(loadConfig().a11y.uiScale)))
    if (last) sendTo(w, 'a11y:keyboard-state', last)
  })
  w.on('closed', () => {
    win = null
  })
  loadRenderer(w, 'a11y', '/keyboard')
  return w
}

export function show(): void {
  const w = get()
  if (!w) create()
  else if (!w.isVisible()) w.showInactive()
}

export function hide(): void {
  get()?.hide()
}

export function isVisible(): boolean {
  return !!get()?.isVisible()
}

export function sendState(state: ScanKeyboardState): void {
  last = state
  sendTo(win, 'a11y:keyboard-state', state)
}

registerWindow(get, { zoom: true, interactive: true })
