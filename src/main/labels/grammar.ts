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

const NAME_THIS = /^(?:label|name|call) (?:this|that)(?: button| icon| one)? (?:as |to )?(.{2,60})$/

export function parseLabelCommand(utterance: string): LabelCommand | null {
  const raw = utterance.replace(/\s+/g, ' ').trim()
  const u = clean(raw)
  if (WINDOW.test(u)) return { kind: 'label-window' }
  const m = NAME_THIS.exec(u)
  if (m && !/^(?:window|app|page|lesson|skill)$/.test(m[1])) {
    // Keep the user's own capitals for the label.
    const start = raw.toLowerCase().lastIndexOf(m[1])
    const label = (start >= 0 ? raw.slice(start, start + m[1].length) : m[1]).replace(/[.!?]+$/, '')
    return { kind: 'name-this', label: label.charAt(0).toUpperCase() + label.slice(1) }
  }
  return null
}
