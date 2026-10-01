// Dwell click-type palette (06 T08): a narrow always-on-top dock, right edge of the primary
// display by default, moved by its grip. It never takes focus, so the app being clicked keeps
// keyboard focus; dwells on it become plain clicks (a11y/dwell.ts).
import { screen, type BrowserWindow } from 'electron'
import type { DwellPaletteState } from '@shared/channels'
import { createWindow, loadRenderer } from './factory'
import { clampScale, live, registerWindow, sendTo } from './registry'
import { themeBackground } from './settings'
import { loadConfig } from '../config'
import { effectiveScale } from '../a11y/text-scale'

const WIDTH = 76
const HEIGHT = 440
const EDGE_GAP = 8

let win: BrowserWindow | null = null
let last: DwellPaletteState | null = null

export function get(): BrowserWindow | null {
  return live(win)
}

/** Right edge, vertically centred; sized for the UI scale the window is zoomed by. */
function placement(): Electron.Rectangle {
  const wa = screen.getPrimaryDisplay().workArea
  const scale = clampScale(effectiveScale(loadConfig().a11y.uiScale))
  const width = Math.round(WIDTH * scale)
  const height = Math.min(Math.round(HEIGHT * scale), wa.height)
  return {
    x: wa.x + wa.width - width - EDGE_GAP,
    y: Math.round(wa.y + (wa.height - height) / 2),
    width,
    height
  }
}

function create(): BrowserWindow {
  const w = createWindow({
    ...placement(),
    title: 'Lumen dwell',
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
    if (last) sendTo(w, 'a11y:dwell-state', last)
  })
  w.on('closed', () => {
    win = null
  })
  loadRenderer(w, 'a11y', '/palette')
  return w
}

/** Shows the dock when dwell and the palette are both on, else hides it. */
export function setVisible(on: boolean): void {
  const w = get()
  if (!on) {
    w?.hide()
    return
  }
  if (!w) create()
  else if (!w.isVisible()) w.showInactive()
}

export function sendState(state: DwellPaletteState): void {
  last = state
  sendTo(win, 'a11y:dwell-state', state)
}

/** True when a logical point is over the visible dock. */
export function contains(p: { x: number; y: number }): boolean {
  const w = get()
  if (!w || !w.isVisible()) return false
  const b = w.getBounds()
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}

registerWindow(get, { zoom: true, interactive: true })
