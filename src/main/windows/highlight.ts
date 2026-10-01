// Guide highlights, locate boxes and the pointer: the old highlight events, drawn as one scene
// on the per-display screen layer.
import type { EventChannel, EventChannels } from '@shared/channels'
import type { GuideStep, LocateItem, Point } from '@shared/types'
import * as layer from './screen-layer'

export function send<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  const arg = args[0]
  if (channel === 'screen:highlights') layer.setHighlights(arg as GuideStep[])
  else if (channel === 'screen:pointer') layer.setPointer(arg as Point & { text: string })
  else if (channel === 'screen:locate') layer.setLocate(arg as LocateItem[])
  else if (channel === 'screen:clear') layer.clear()
}

export function show(): void {
  layer.show()
}

export function hide(): void {
  layer.hide()
}

export function isVisible(): boolean {
  return layer.isVisible()
}

/** Hides the layer and drops everything drawn on it. */
export function clear(): void {
  layer.clear()
}
