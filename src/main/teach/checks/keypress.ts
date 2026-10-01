// keypress: the user pressed a key combo. Needs 02's observe-only `key-combo` event, which
// is subscribed only while a lesson step is active and never suppresses the key. Without it
// the check cannot tell and answers 'unknown' (the step's vision/title alternates decide).
import type { CheckHandle, CheckContext } from './types'
import { settleable } from './types'

const ALIAS: Record<string, string> = {
  control: 'ctrl',
  windows: 'win',
  meta: 'win',
  super: 'win',
  cmd: 'win',
  command: 'win',
  option: 'alt',
  return: 'enter',
  escape: 'esc',
  del: 'delete'
}
const MODS = ['ctrl', 'alt', 'shift', 'win']

/** "Shift+Control+a" → "ctrl+shift+a": aliases folded, modifiers in a fixed order. */
export function normalizeCombo(combo: string): string {
  const keys = combo
    .split('+')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => ALIAS[k] ?? k)
  const mods = MODS.filter((m) => keys.includes(m))
  const rest = keys.filter((k) => !MODS.includes(k)).sort()
  return [...mods, ...rest].join('+')
}

export function start(spec: { combo: string }, ctx: CheckContext): CheckHandle {
  const want = normalizeCombo(spec.combo)
  const r = settleable()
  if (!ctx.ports.keys.available()) ctx.log('keypress: no key-combo events; relying on other checks')
  const off = ctx.ports.keys.onCombo((combo) => {
    if (normalizeCombo(combo) === want) r.settle('pass')
  })
  return {
    result: r.promise,
    evaluate: async () => (r.passed() ? 'pass' : 'unknown'),
    cancel: () => {
      off()
      r.settle('unknown')
    }
  }
}
