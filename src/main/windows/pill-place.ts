// Where the assistant window goes so its card (the dictation pill) sits next to the text caret
// (04 T47). The card is drawn centred at the bottom of the window, `bottomPad` above its edge,
// so the window is moved rather than the card. Pure; logical (DIP) px.

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface PillLayout {
  /** Window size (as placed normally). */
  width: number
  height: number
  /** Space between the card's bottom and the window's bottom edge. */
  bottomPad: number
  /** Height of the compact pill card. */
  pillHeight: number
  /** Gap between the caret and the pill. */
  gap: number
}

/** Window bounds that put the pill just below the anchor (above it near the screen bottom). */
export function pillBounds(anchor: Box, workArea: Box, l: PillLayout): Box {
  const centreX = anchor.x + Math.min(anchor.width, 24) / 2
  let x = Math.round(centreX - l.width / 2)
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - l.width))
  const below = anchor.y + anchor.height + l.gap + l.pillHeight
  const fitsBelow = below <= workArea.y + workArea.height
  const cardBottom = fitsBelow ? below : anchor.y - l.gap
  const y = Math.round(cardBottom + l.bottomPad - l.height)
  return { x, y, width: l.width, height: l.height }
}
