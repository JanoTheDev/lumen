// Rewrites answer text for listening: no markdown symbols, no URLs or code read out, and
// keyboard shortcuts said the way people say them.

const KEY_NAMES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  win: 'Windows',
  cmd: 'Command',
  esc: 'Escape',
  del: 'Delete',
  pgup: 'Page Up',
  pgdn: 'Page Down',
  enter: 'Enter',
  tab: 'Tab'
}

const keyName = (k: string): string => KEY_NAMES[k.toLowerCase()] ?? k

// Ctrl+Shift+S, Alt + F4, Win+E: at least one modifier, then a key.
const SHORTCUT_RE = /\b((?:ctrl|control|alt|shift|win|cmd)(?:\s*\+\s*[A-Za-z0-9]+)+)\b/gi

export function forTheEar(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' I put the code on screen. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, 'the link on screen')
    .replace(SHORTCUT_RE, (combo) =>
      combo
        .split('+')
        .map((k) => keyName(k.trim()))
        .join(' ')
    )
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~#>|]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\.(\s*\.)+/g, '.')
    .trim()
}
