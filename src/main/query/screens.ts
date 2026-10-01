// Multi-monitor frames: the foreground monitor is always frame "1" (marks, the UIA list and
// legacy bbox replies refer to it); the others follow in left-to-right order. Each frame gets a
// spoken-style name for the prompt: "Screen 2 (primary, left)".
import type { MonitorInfo } from '@shared/types'

interface Labelled {
  label: string
  monitor?: MonitorInfo
}

const centerOf = (m: MonitorInfo): { x: number; y: number } => ({
  x: m.rect.x + m.rect.w / 2,
  y: m.rect.y + m.rect.h / 2
})

/** Foreground monitor first, then the rest by position (left to right, top to bottom). */
export function orderFrames<T extends Labelled>(frames: T[], foregroundMonitor?: number): T[] {
  if (frames.length < 2) return frames
  const pos = (f: T): number[] => (f.monitor ? [f.monitor.rect.x, f.monitor.rect.y] : [0, 0])
  const sorted = [...frames].sort((a, b) => {
    const fa = a.monitor?.id === foregroundMonitor ? 0 : 1
    const fb = b.monitor?.id === foregroundMonitor ? 0 : 1
    if (fa !== fb) return fa - fb
    const [ax, ay] = pos(a)
    const [bx, by] = pos(b)
    return ax - bx || ay - by
  })
  return sorted.map((f, i) => ({ ...f, label: String(i + 1) }))
}

/** Where each monitor sits relative to the others: "left", "right", "middle", "top", "bottom". */
function placeOf(m: MonitorInfo, all: MonitorInfo[]): string | null {
  if (all.length < 2) return null
  const c = centerOf(m)
  const xs = all.map((o) => centerOf(o).x)
  const ys = all.map((o) => centerOf(o).y)
  const spreadX = Math.max(...xs) - Math.min(...xs)
  const spreadY = Math.max(...ys) - Math.min(...ys)
  if (spreadX >= spreadY) {
    if (c.x === Math.min(...xs)) return 'left'
    if (c.x === Math.max(...xs)) return 'right'
    return 'middle'
  }
  if (c.y === Math.min(...ys)) return 'top'
  if (c.y === Math.max(...ys)) return 'bottom'
  return 'middle'
}

/** "Screen 1 (primary, left)" per frame label, in frame order. */
export function screenNames(frames: Labelled[]): Map<string, string> {
  const monitors = frames.map((f) => f.monitor).filter((m): m is MonitorInfo => !!m)
  const names = new Map<string, string>()
  for (const f of frames) {
    const tags: string[] = []
    if (f.monitor?.primary) tags.push('primary')
    const place = f.monitor ? placeOf(f.monitor, monitors) : null
    if (place) tags.push(place)
    names.set(f.label, `Screen ${f.label}${tags.length ? ` (${tags.join(', ')})` : ''}`)
  }
  return names
}
