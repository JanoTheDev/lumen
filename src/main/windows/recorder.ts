// The hidden lesson recorder window (07 T30). It exists only while a lesson recording starts
// or runs: it captures one screen with getUserMedia + MediaRecorder (webm) and sends the file
// to main in pieces. Display capture is allowed for it only while a recording is active
// (windows/permissions). While it records, Lumen's own windows except the screen layer (the
// lesson's highlights and buddy belong in the video) are kept out of every screen capture.
import { app, BrowserWindow } from 'electron'
import { createWindow, loadRenderer } from './factory'
import { setDisplayCaptureActive } from './permissions'
import * as screenLayer from './screen-layer'

let win: BrowserWindow | null = null
let capturing = false
const protectedIds = new Set<number>()

export function isRecorderSender(id: number): boolean {
  return !!win && !win.isDestroyed() && win.webContents.id === id
}

export function openRecorder(onGone: (why: string) => void): void {
  if (win && !win.isDestroyed()) return
  const w = createWindow({
    show: false,
    width: 320,
    height: 200,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    title: 'Lumen lesson recorder'
  })
  win = w
  w.on('closed', () => {
    if (win === w) {
      win = null
      onGone('the recorder window closed')
    }
  })
  w.webContents.on('render-process-gone', () => onGone('the recorder window stopped'))
  loadRenderer(w, 'recorder')
}

export function stopRecorder(): void {
  if (win && !win.isDestroyed()) win.webContents.send('recorder:stop')
}

export function closeRecorder(): void {
  const w = win
  win = null
  if (w && !w.isDestroyed()) w.destroy()
}

function keepOut(w: BrowserWindow): void {
  if (w.isDestroyed() || w === win || protectedIds.has(w.id)) return
  if (screenLayer.windows().includes(w)) return
  w.setContentProtection(true)
  protectedIds.add(w.id)
}

const onCreated = (_e: unknown, w: BrowserWindow): void => {
  // The new window's id is known now; its renderer loads later.
  if (capturing) keepOut(w)
}

/** Recording on: the recorder may capture the screen; Lumen's bar and panels stay out of it. */
export function setCapturing(on: boolean): void {
  if (on === capturing) return
  capturing = on
  setDisplayCaptureActive(on)
  if (on) {
    for (const w of BrowserWindow.getAllWindows()) keepOut(w)
    app.on('browser-window-created', onCreated)
    return
  }
  app.removeListener('browser-window-created', onCreated)
  for (const w of BrowserWindow.getAllWindows())
    if (protectedIds.has(w.id) && !w.isDestroyed()) w.setContentProtection(false)
  protectedIds.clear()
}
