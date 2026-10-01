// Voice commands for community labels (11 T13). Whole utterances only. No Electron.

export type LabelCommand = { kind: 'label-window' } | { kind: 'name-this'; label: string }

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const WINDOW =
  /^(?:please )?(?:label|name) (?:all )?(?:the )?(?:unlabeled |unlabelled |unnamed |icon )?(?:buttons|icons|controls|this window|this app|everything)(?: here| in this window| in this app| for me)?(?: please)?$/

// "call" only with a control word: "call that number" is a phone request, not a label.
const NAME_THIS =
  /^(?:(?:label|name) (?:this|that)(?: button| icon| control| one)?|call (?:this|that) (?:button|icon|control)) (?:as |to )?(.{2,60})$/
/** "name this file report", "label that photo holiday": naming a thing, not a control. */
const NOT_A_CONTROL =
  /^(?:window|app|page|lesson|skill|file|folder|document|doc|photo|picture|image|song|track|playlist|tab|note|project|layer|sheet|number|contact)\b/

export function parseLabelCommand(utterance: string): LabelCommand | null {
  const raw = utterance.replace(/\s+/g, ' ').trim()
  const u = clean(raw)
  if (WINDOW.test(u)) return { kind: 'label-window' }
  const m = NAME_THIS.exec(u)
  if (m && !NOT_A_CONTROL.test(m[1])) {
    // Keep the user's own capitals for the label.
    const start = raw.toLowerCase().lastIndexOf(m[1])
    const label = (start >= 0 ? raw.slice(start, start + m[1].length) : m[1]).replace(/[.!?]+$/, '')
    return { kind: 'name-this', label: label.charAt(0).toUpperCase() + label.slice(1) }
  }
  return null
}
