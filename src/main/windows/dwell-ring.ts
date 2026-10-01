// Dwell ring: drawn by the screen layer. The a11y dwell controller decides what the ring
// shows; this only makes sure the layer exists.
import type { DwellRingData } from '@shared/channels'
import * as layer from './screen-layer'

export function setEnabled(enabled: boolean): void {
  if (enabled) layer.create()
  else layer.dwell({ x: -1e6, y: -1e6, progress: 0, active: false })
}

/** Ring position in global logical px; the layer under it draws it in its own DIP. */
export function progress(data: DwellRingData): void {
  layer.create()
  layer.dwell(data)
}
