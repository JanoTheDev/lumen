// Every Lumen window registers here so config broadcasts, UI scale and hit-testing
// reach all of them without importing each module.
import type { BrowserWindow } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'

interface Entry {
  get: () => BrowserWindow | null
  /** Scaled by the a11y UI scale setting. */
  zoom: boolean
  /** Dwell clicks over this window are suppressed. */
  interactive: boolean
}

const entries: Entry[] = []

export function registerWindow(
  get: () => BrowserWindow | null,
  opts: { zoom?: boolean; interactive?: boolean } = {}
): void {
  entries.push({ get, zoom: !!opts.zoom, interactive: !!opts.interactive })
}

export function live(win: BrowserWindow | null): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

export function sendTo<C extends EventChannel>(
  win: BrowserWindow | null,
  channel: C,
  ...args: EventChannels[C]
): void {
  live(win)?.webContents.send(channel, ...args)
}

export function broadcast<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  for (const e of entries) sendTo(e.get(), channel, ...args)
}

export function clampScale(scale: number): number {
  return Math.max(0.75, Math.min(1.6, scale || 1))
}

// Only zoom overlays the user-facing chrome sits on; keep settings/highlight at 1.
export function applyUiScale(scale: number): void {
  const s = clampScale(scale)
  for (const e of entries) {
    if (e.zoom) live(e.get())?.webContents.setZoomFactor(s)
  }
}

/** Applies the saved UI scale once each zoomed window finishes loading. */
export function applyUiScaleOnLoad(scale: number): void {
  for (const e of entries) {
    const w = e.zoom ? live(e.get()) : null
    if (!w) continue
    w.webContents.once('did-finish-load', () => {
      if (!w.isDestroyed()) w.webContents.setZoomFactor(clampScale(scale))
    })
  }
}

/** True when a logical-px point is over one of Lumen's visible interactive windows. */
export function isOverOwnWindow(pt: { x: number; y: number }): boolean {
  return entries.some((e) => {
    const w = e.interactive ? live(e.get()) : null
    if (!w || !w.isVisible()) return false
    const b = w.getBounds()
    return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height
  })
}
