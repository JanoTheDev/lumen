// Switch key capture (06 T09 / 03 T17 item 4): any single key without modifiers, named the way
// the native hook and Electron accept it, plus the clash check against Lumen's own shortcuts.
import { SWITCH_KEY_RE } from '@shared/config'
import type { Config } from '../useConfig'

/** event.code → name for keys whose event.key is ambiguous (numpad) or not an accelerator. */
const BY_CODE: Record<string, string> = {
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  NumpadEnter: 'Enter'
}

const BY_KEY: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  MediaPlayPause: 'MediaPlayPause'
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'])

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** The switch key name for a key press, or why it can't be one. Tab / Escape are the caller's. */
export function switchKeyFromEvent(e: KeyLike): { key: string } | { problem: string } {
  if (MODIFIER_KEYS.has(e.key) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)
    return { problem: 'Use one key on its own, without Ctrl, Alt, Shift or Windows.' }
  // With Num Lock off the numpad sends End, Down… and those names are kept.
  const numpadDigit = /^[0-9]$/.test(e.key) ? /^Numpad([0-9])$/.exec(e.code) : null
  const name = numpadDigit
    ? `num${numpadDigit[1]}`
    : (BY_CODE[e.code] ?? BY_KEY[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key))
  if (!SWITCH_KEY_RE.test(name)) return { problem: `${name} can’t be a switch. Try another key.` }
  return { key: name }
}

/** Lumen shortcuts that are one bare key (F-keys) and would clash with `key`. */
export function switchKeyClash(key: string, cfg: Config, others: readonly string[] = []): string {
  const k = key.toLowerCase()
  if (others.some((o) => o.toLowerCase() === k)) return `${key} is already your other switch.`
  const shortcuts: Array<[string, string | undefined]> = [
    ['the talk shortcut', cfg.hotkey],
    ['the dictation shortcut', cfg.dictation.hotkey],
    ['the help shortcut', cfg.a11y.helpHotkey],
    ['the Home shortcut', cfg.ui.homeHotkey],
    ...Object.entries(cfg.a11y.shortcuts).map(([name, combo]): [string, string] => [
      `the “${name.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}” shortcut`,
      combo
    ])
  ]
  const hit = shortcuts.find(([, combo]) => combo?.toLowerCase() === k)
  return hit ? `${key} is ${hit[0]}. Pick another key or change that shortcut first.` : ''
}
