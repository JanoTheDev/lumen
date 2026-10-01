// Deictic voice commands (11 T15): "click this", "double click that", "right click here",
// "move this there", "put that over here", "what's that", "what does this do". Whole
// utterances only. `refs` are the word indexes of the pointing words ("this", "there"), so
// each can be matched to where the pointer was when it was spoken. No Electron.

export type DeicticCommand =
  | { kind: 'click'; button: 'left' | 'right'; count: 1 | 2; refs: [number] }
  | { kind: 'drag'; refs: [number, number] }
  | { kind: 'what'; refs: [number] }

const POINT = new Set(['this', 'that', 'here', 'there', 'it'])

/** Lowercase words without punctuation (apostrophes dropped: "what's" → "whats"). */
export function words(utterance: string): string[] {
  return utterance
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

const CLICK: { re: RegExp; button: 'left' | 'right'; count: 1 | 2 }[] = [
  {
    re: /^(?:please )?(?:left )?click (?:on )?(this|that|here|there)(?: please)?$/,
    button: 'left',
    count: 1
  },
  { re: /^(?:please )?(?:press|select|tap) (this|that)(?: please)?$/, button: 'left', count: 1 },
  {
    re: /^(?:please )?double click (?:on )?(this|that|here|there)(?: please)?$/,
    button: 'left',
    count: 2
  },
  { re: /^(?:please )?open (this|that)(?: please)?$/, button: 'left', count: 2 },
  {
    re: /^(?:please )?right click (?:on )?(this|that|here|there)(?: please)?$/,
    button: 'right',
    count: 1
  }
]

const DRAG =
  /^(?:please )?(?:move|drag|put|drop) (this|that|it)(?: one)? (?:(?:over|up|down) )?(?:to |into |onto |in |on )?(?:(?:over|up|down) )?(there|here)(?: please)?$/

const WHAT =
  /^(?:(?:and )?whats (this|that)(?: thing| one| button| icon)?|what is (this|that)(?: thing| one| button| icon)?|what does (this|that)(?: button| icon| one)? do|tell me what (this|that) is)$/

/** Index of the n-th (0-based) pointing word in `w`. */
function refIndex(w: string[], n: number): number {
  let seen = -1
  for (let i = 0; i < w.length; i++) if (POINT.has(w[i]) && ++seen === n) return i
  return -1
}

export function parseDeictic(utterance: string): DeicticCommand | null {
  const w = words(utterance)
  if (!w.length || w.length > 10) return null
  const text = w.join(' ')
  for (const c of CLICK)
    if (c.re.test(text))
      return { kind: 'click', button: c.button, count: c.count, refs: [refIndex(w, 0)] }
  if (DRAG.test(text)) return { kind: 'drag', refs: [refIndex(w, 0), refIndex(w, 1)] }
  if (WHAT.test(text)) return { kind: 'what', refs: [refIndex(w, 0)] }
  return null
}
