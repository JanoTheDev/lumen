// Windows "Text size" (Settings → Accessibility → Text size, 100–225 %) for Lumen's windows
// (06 T16). The agent reads HKCU\Software\Microsoft\Accessibility\TextScaleFactor and sends it
// in `system-settings` on subscribe and whenever Windows reports a settings change. Renderers
// get it with the config (theme/apply.ts multiplies it in) and zoomed windows get uiScale × text size.

let factor = 100
const listeners = new Set<(factor: number) => void>()

/** A valid text size in percent, or null. */
export function parseTextScale(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 225 ? raw : null
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

/** Applies the agent's value; listeners run only on a change. Invalid values mean 100 %. */
export function setTextScale(raw: unknown): void {
  const next = parseTextScale(raw) ?? 100
  if (next === factor) return
  factor = next
  for (const fn of listeners) fn(next)
}
