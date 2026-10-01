// Every Lumen window registers here so config broadcasts, UI scale and hit-testing
// reach all of them without importing each module.
import type { BrowserWindow, Rectangle } from 'electron'
import type { EventChannel, EventChannels } from '@shared/channels'
import { loadConfig } from '../config'
import { effectiveScale } from '../a11y/text-scale'

interface Entry {
  get: () => BrowserWindow | null
  /** Scaled by the a11y UI scale setting. */
  zoom: boolean
  /** Dwell clicks over this window are suppressed. */
  interactive: boolean
  /** Screen rect that counts as the window for hit-testing; default its bounds. */
  hitRect?: () => Rectangle | null
}

const entries: Entry[] = []
const sets: Array<() => BrowserWindow[]> = []
const local = new Map<EventChannel, Array<(...args: unknown[]) => void>>()

/** Main-side listener for a broadcast, e.g. a window module reacting to settings:changed. */
export function onBroadcast<C extends EventChannel>(
  channel: C,
  fn: (...args: EventChannels[C]) => void
): void {
  local.set(channel, [...(local.get(channel) ?? []), fn as (...args: unknown[]) => void])
}

/** A group of windows (one per display) that only receives broadcasts. */
export function registerWindowSet(getAll: () => BrowserWindow[]): void {
  sets.push(getAll)
}

export function registerWindow(
  get: () => BrowserWindow | null,
  opts: { zoom?: boolean; interactive?: boolean; hitRect?: () => Rectangle | null } = {}
): void {
  entries.push({
    get,
    zoom: !!opts.zoom,
    interactive: !!opts.interactive,
    hitRect: opts.hitRect
  })
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
  for (const getAll of sets) for (const w of getAll()) sendTo(w, channel, ...args)
  for (const fn of local.get(channel) ?? []) fn(...args)
}

export function clampScale(scale: number): number {
  return Math.max(0.75, Math.min(2, scale || 1))
}

// Only zoom overlays the user-facing chrome sits on; keep settings/highlight at 1.
export function applyUiScale(scale: number): void {
  const s = clampScale(scale)
  for (const e of entries) {
    if (e.zoom) live(e.get())?.webContents.setZoomFactor(s)
  }
}

export function currentZoom(win: BrowserWindow | null): number {
  const w = live(win)
  return w ? w.webContents.getZoomFactor() : 1
}

/**
 * Applies the zoom (uiScale × Windows text size) whenever a zoomed window finishes loading.
 * Read at load time so a text-size change made since start-up is not overwritten.
 */
export function applyUiScaleOnLoad(): void {
  for (const e of entries) {
    const w = e.zoom ? live(e.get()) : null
    if (!w) continue
    w.webContents.on('did-finish-load', () => {
      if (!w.isDestroyed())
        w.webContents.setZoomFactor(clampScale(effectiveScale(loadConfig().a11y.uiScale)))
    })
  }
}
