// Windows "Text size" (Settings → Accessibility → Text size, 100–225 %) for Lumen's windows
// (06 T16). Read from HKCU\Software\Microsoft\Accessibility\TextScaleFactor; Windows has no
// change event Electron exposes, so it is re-read on a slow poll. Renderers get it with the
// config (theme/apply.ts multiplies it in) and zoomed windows get uiScale × text size.
import { execFile } from 'child_process'

const KEY = 'HKCU\\Software\\Microsoft\\Accessibility'
const POLL_MS = 30_000

let factor = 100
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<(factor: number) => void>()

/** "TextScaleFactor    REG_DWORD    0x96" → 150; null when absent or out of range. */
export function parseTextScale(regOutput: string): number | null {
  const m = /TextScaleFactor\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput)
  if (!m) return null
  const v = parseInt(m[1], 16)
  return v >= 100 && v <= 225 ? v : null
}

/** Windows text size in percent (100 when unknown). */
export function textScaleFactor(): number {
  return factor
}

/** uiScale × text size, the zoom for windows main scales itself. */
export function effectiveScale(uiScale: number): number {
  return uiScale * (factor / 100)
}

export function onTextScaleChange(fn: (factor: number) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function read(): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(100)
    execFile('reg', ['query', KEY, '/v', 'TextScaleFactor'], { windowsHide: true }, (err, out) =>
      resolve(err ? 100 : (parseTextScale(String(out)) ?? 100))
    )
  })
}

export async function refreshTextScale(): Promise<number> {
  const next = await read()
  if (next !== factor) {
    factor = next
    for (const fn of listeners) fn(next)
  }
  return factor
}

/** Reads once now and then every 30 s. */
export function watchTextScale(): void {
  if (timer) return
  void refreshTextScale()
  timer = setInterval(() => void refreshTextScale(), POLL_MS)
  timer.unref?.()
}
