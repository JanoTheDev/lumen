// WCAG 2 contrast maths plus an OKLCH lightness nudge for colours that fall short.

export type Rgb = [number, number, number]

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

export function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v)
}

export function parseHex(hex: string): Rgb {
  const m = HEX_RE.exec(hex.trim())
  if (!m) throw new Error(`not a hex colour: ${hex}`)
  let h = m[1]
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

export function toHex([r, g, b]: Rgb): string {
  const c = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase()
}

const toLinear = (c: number): number => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const fromLinear = (l: number): number => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
  return s * 255
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function ratio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** White when it reaches AA on `bg` (the platform convention), otherwise the better of black or white. */
export function pickOnColor(bg: string): '#000' | '#fff' {
  const white = ratio(bg, '#FFFFFF')
  if (white >= 4.5) return '#fff'
  return ratio(bg, '#000000') >= white ? '#000' : '#fff'
}

/** Mixes `a` into `b` by `amount` (0..1) in sRGB, like CSS color-mix. */
export function mix(a: string, b: string, amount: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  return toHex(ca.map((v, i) => v * amount + cb[i] * (1 - amount)) as Rgb)
}

// OKLab / OKLCH (Björn Ottosson's reference matrices).
type Lch = [number, number, number]

function hexToOklch(hex: string): Lch {
  const [r, g, b] = parseHex(hex).map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), Math.atan2(B, A)]
}

function oklchToRgb([L, C, h]: Lch): Rgb {
  const A = C * Math.cos(h)
  const B = C * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return [r, g, b].map((v) => fromLinear(Math.min(1, Math.max(0, v)))) as Rgb
}

/**
 * Returns `fg`, or the nearest colour (same hue, shifted OKLCH lightness) that reaches
 * `min` contrast against `bg`. Falls back to black or white when no shift is enough.
 */
export function ensureContrast(fg: string, bg: string, min: number): string {
  if (ratio(fg, bg) >= min) return toHex(parseHex(fg))
  const [L, C, h] = hexToOklch(fg)
  const towardDark = luminance(bg) > 0.18
  const directions = towardDark ? [-1, 1] : [1, -1]
  for (const dir of directions) {
    for (let step = 1; step <= 100; step++) {
      const nextL = L + dir * step * 0.01
      if (nextL < 0 || nextL > 1) break
      const candidate = toHex(oklchToRgb([nextL, C, h]))
      if (ratio(candidate, bg) >= min) return candidate
    }
  }
  return pickOnColor(bg) === '#000' ? '#000000' : '#FFFFFF'
}
