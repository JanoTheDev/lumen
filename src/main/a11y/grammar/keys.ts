// Spoken key names → normalized combo parts ("control shift t" → ["ctrl","shift","t"]).

const KEY_WORDS: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  escape: 'esc',
  esc: 'esc',
  tab: 'tab',
  space: 'space',
  spacebar: 'space',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  home: 'home',
  end: 'end',
  insert: 'insert',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  windows: 'win',
  win: 'win',
  plus: '',
  and: ''
}

const MULTI: Array<[RegExp, string]> = [
  [/\bpage up\b/g, 'pageup'],
  [/\bpage down\b/g, 'pagedown'],
  [/\b(up|down|left|right) arrow\b/g, '$1'],
  [/\barrow (up|down|left|right)\b/g, '$1'],
  [/\bback space\b/g, 'backspace'],
  [/\bspace bar\b/g, 'space'],
  [/\bf (1[0-2]|[1-9])\b/g, 'f$1'],
  [/\bf (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, 'f:$1']
]

const F_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
}

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'win'])

/** Parses spoken keys; null when any word is not a key or there is no non-modifier key. */
export function parseKeys(spoken: string): string[] | null {
  let t = spoken.trim().replace(/\+/g, ' ')
  for (const [re, rep] of MULTI) t = t.replace(re, rep)
  const out: string[] = []
  for (const raw of t.split(/\s+/).filter(Boolean)) {
    let key: string | undefined
    if (raw.startsWith('f:')) key = `f${F_WORDS[raw.slice(2)]}`
    else if (/^f(1[0-2]|[1-9])$/.test(raw)) key = raw
    else if (raw === 'pageup' || raw === 'pagedown') key = raw
    else if (raw in KEY_WORDS) key = KEY_WORDS[raw]
    else if (/^[a-z0-9]$/.test(raw)) key = raw
    if (key === undefined) return null
    if (key && !out.includes(key)) out.push(key)
  }
  const mods = ['ctrl', 'alt', 'shift', 'win'].filter((m) => out.includes(m))
  const rest = out.filter((k) => !MODIFIERS.has(k))
  // "press windows" alone is allowed as a key of its own; otherwise a real key is needed.
  if (!rest.length) return mods.length === 1 && mods[0] === 'win' ? ['win'] : null
  if (rest.length > 1) return null
  return [...mods, ...rest]
}
