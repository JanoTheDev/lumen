// Perceptual frame comparison for settle waits and verification: frames are decoded and
// downscaled to small grayscale images (never compared as JPEG bytes, AM step-verifier:393),
// and crops for the vision verifier are cut from the full frame.
import { nativeImage } from 'electron'
import type { Rect } from '@shared/types'

export interface GrayImage {
  w: number
  h: number
  /** One byte per pixel, row-major. */
  data: Uint8Array
}

/** Width frames are reduced to before diffing: a blinking caret barely moves the mean. */
export const DIFF_WIDTH = 160
/** Mean abs difference below this = the frames show the same thing (0.5%). */
export const SAME_RATIO = 0.005
/** Mean abs difference above this = something visibly changed (2%). */
export const CHANGED_RATIO = 0.02

export interface FrameCodec {
  /** Base64 JPEG/PNG → grayscale at `width` px wide; null when it cannot be decoded. */
  gray(b64: string, width: number): GrayImage | null
  /** A JPEG crop of the image (image px), or null. */
  crop(b64: string, rect: Rect): string | null
}

const electronCodec: FrameCodec = {
  gray(b64, width) {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
    if (img.isEmpty()) return null
    const small = img.resize({ width: Math.min(width, img.getSize().width), quality: 'good' })
    const { width: w, height: h } = small.getSize()
    const bgra = small.toBitmap()
    const data = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      data[i] = Math.round(0.114 * bgra[o] + 0.587 * bgra[o + 1] + 0.299 * bgra[o + 2])
    }
    return { w, h, data }
  },
  crop(b64, rect) {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
    if (img.isEmpty()) return null
    const size = img.getSize()
    const x = Math.max(0, Math.round(rect.x))
    const y = Math.max(0, Math.round(rect.y))
    const w = Math.min(size.width - x, Math.round(rect.w))
    const h = Math.min(size.height - y, Math.round(rect.h))
    if (w < 4 || h < 4) return null
    return img.crop({ x, y, width: w, height: h }).toJPEG(80).toString('base64')
  }
}

let codec: FrameCodec = electronCodec

/** Test hook: replace (or with null, reset) the image codec. */
export function setFrameCodec(c: FrameCodec | null): void {
  codec = c ?? electronCodec
}

export function decodeGray(b64: string, width = DIFF_WIDTH): GrayImage | null {
  try {
    return codec.gray(b64, width)
  } catch {
    return null
  }
}

export function cropImage(b64: string, rect: Rect): string | null {
  try {
    return codec.crop(b64, rect)
  } catch {
    return null
  }
}

/** A sub-rectangle as fractions of the image (0..1). */
export interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Mean absolute difference (0..1) between two gray images, over `region` (fractions of the
 * image) or the whole image. Different sizes count as fully different.
 */
export function diffRatio(a: GrayImage, b: GrayImage, region?: Region): number {
  if (a.w !== b.w || a.h !== b.h || !a.w || !a.h) return 1
  const x0 = region ? Math.max(0, Math.floor(region.x * a.w)) : 0
  const y0 = region ? Math.max(0, Math.floor(region.y * a.h)) : 0
  const x1 = region ? Math.min(a.w, Math.ceil((region.x + region.w) * a.w)) : a.w
  const y1 = region ? Math.min(a.h, Math.ceil((region.y + region.h) * a.h)) : a.h
  if (x1 <= x0 || y1 <= y0) return 0
  let sum = 0
  for (let y = y0; y < y1; y++) {
    const row = y * a.w
    for (let x = x0; x < x1; x++) sum += Math.abs(a.data[row + x] - b.data[row + x])
  }
  return sum / ((x1 - x0) * (y1 - y0) * 255)
}
