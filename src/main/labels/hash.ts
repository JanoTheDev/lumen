// Icon hash (11 T13): a 64-bit difference hash of a control's pixels, so a label found for an
// icon also fits that icon where the control has no automation id (or a new one after an
// update). Small theme, scale and anti-aliasing changes stay within a few bits. No Electron.
import type { GrayImage } from '../ai/frames'

/** Bits two hashes may differ in and still be the same icon. */
export const HASH_MATCH_BITS = 6

/** Mean of the box [x0,x1) × [y0,y1) (at least one pixel). */
function boxMean(img: GrayImage, x0: number, x1: number, y0: number, y1: number): number {
  const xa = Math.min(img.w - 1, Math.floor(x0))
  const ya = Math.min(img.h - 1, Math.floor(y0))
  const xb = Math.max(xa + 1, Math.min(img.w, Math.ceil(x1)))
  const yb = Math.max(ya + 1, Math.min(img.h, Math.ceil(y1)))
  let sum = 0
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) sum += img.data[y * img.w + x]
  return sum / ((xb - xa) * (yb - ya))
}

/** 16 hex chars; null for an image too small or flat to say anything. */
export function iconHash(img: GrayImage | null): string | null {
  if (!img || img.w < 4 || img.h < 4) return null
  const cells: number[] = []
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 9; c++)
      cells.push(
        boxMean(img, (c * img.w) / 9, ((c + 1) * img.w) / 9, (r * img.h) / 8, ((r + 1) * img.h) / 8)
      )
  if (Math.max(...cells) - Math.min(...cells) < 8) return null
  let hex = ''
  for (let r = 0; r < 8; r++) {
    let byte = 0
    for (let c = 0; c < 8; c++)
      byte = (byte << 1) | (cells[r * 9 + c] > cells[r * 9 + c + 1] ? 1 : 0)
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let bits = 0
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)
    while (x) {
      bits += x & 1
      x >>= 1
    }
  }
  return bits
}
