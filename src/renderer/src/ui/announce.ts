// One pair of visually hidden live regions per window. announce() writes into them;
// <LiveRegion/> mounts them. Text is cleared first so repeats are read again.

export type Politeness = 'polite' | 'assertive'

const regions: Partial<Record<Politeness, HTMLElement>> = {}

export function registerRegion(kind: Politeness, el: HTMLElement | null): void {
  if (el) regions[kind] = el
  else delete regions[kind]
}

export function announce(text: string, politeness: Politeness = 'polite'): void {
  const el = regions[politeness]
  if (!el || !text) return
  el.textContent = ''
  window.setTimeout(() => {
    el.textContent = text
  }, 50)
}
