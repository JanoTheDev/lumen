// Dwell ring: drawn by the screen layer (06 DwellRing) in both UI modes. The a11y dwell
// controller decides what the ring shows; this only makes sure the layer exists.
import type { DwellRingData } from '@shared/channels'
import { loadConfig } from '../config'
import * as layer from './screen-layer'

/** Creates the screen layer up front when dwell is on (v1 creates it on first use otherwise). */
export function create(): void {
  if (loadConfig().dwellClick.enabled) layer.create()
}

export function setEnabled(enabled: boolean): void {
  if (enabled) layer.create()
  else layer.dwell({ x: -1e6, y: -1e6, progress: 0, active: false })
}

/** Ring position in global logical px; the layer under it draws it in its own DIP. */
export function progress(data: DwellRingData): void {
  layer.create()
  layer.dwell(data)
}
