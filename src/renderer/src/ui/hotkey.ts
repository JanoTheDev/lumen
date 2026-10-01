// Turns key events into Electron accelerator strings for the shortcut field.

const F_KEYS = /^F([1-9]|1[0-2])$/

/** Builds an accelerator like "Ctrl+Shift+Space" from a key event, or explains what is missing. */
export function comboFromEvent(e: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): { combo: string } | { partial: string } | { problem: string } {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Win')
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return { partial: mods.join('+') }
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (key === ' ') key = 'Space'
  if (!mods.length && !F_KEYS.test(key))
    return { problem: 'Add Ctrl, Alt or Shift, or use F1 to F12.' }
  return { combo: [...mods, key].join('+') }
}
