// How-to text → short steps with the UI names they mention. Works on doc HTML (ordered lists,
// bold UI names, <kbd> shortcuts) and on plain or lightly marked-up text (numbered lines,
// "File > Save As" menu paths, **bold** or "quoted" names, "UI: a; b" tags from the paid-search
// prompt). Everything here is untrusted page text: callers redact and fence it. No Electron.
import { decodeEntities, htmlToText } from '../web/extract'
import type { HowtoStep } from './types'

export const MAX_STEPS = 8
const MAX_STEP_CHARS = 220
const MAX_UI_CHARS = 48
const MAX_UI_PER_STEP = 5

const SHORTCUT_RE =
  /\b(?:ctrl|control|alt|shift|win|windows|cmd|option)(?:\s*\+\s*(?:ctrl|control|alt|shift|win|windows|cmd|option|f\d{1,2}|enter|tab|space|escape|esc|delete|del|home|end|page ?up|page ?down|up|down|left|right|plus|minus|[a-z0-9](?![a-z0-9])|[`\-=[\];',./\\]))+/i

const clean = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–•*]+/, '')
    .trim()

/** A plausible UI label: short, has a letter, not a sentence. */
function uiName(s: string): string | null {
  const t = clean(decodeEntities(s))
    .replace(/^["“'‘]|["”'’]$/g, '')
    .replace(/[.,:;]+$/, '')
    .trim()
  if (!t || t.length > MAX_UI_CHARS || !/\p{L}/u.test(t)) return null
  if (t.split(' ').length > 6) return null
  return t
}

function pushUnique(list: string[], name: string | null): void {
  if (!name || list.length >= MAX_UI_PER_STEP) return
  if (!list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name)
}

/** The keyboard shortcut a step names, normalised ("Ctrl+Shift+N"). */
export function shortcutIn(text: string): string | undefined {
  const m = SHORTCUT_RE.exec(text)
  if (!m) return undefined
  return m[0]
    .split('+')
    .map((k) => k.trim())
    .map((k) => (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)))
    .join('+')
}

/** UI names in plain or markdown text: menu paths, **bold**, "quoted" labels. */
export function uiNamesIn(text: string): string[] {
  const out: string[] = []
  const tag = /\bUI:\s*([^\]|\n]+)/i.exec(text)
  if (tag) {
    // An explicit tag (the paid-search format) is the whole answer.
    for (const part of tag[1].split(/[;,]/)) pushUnique(out, uiName(part))
    return out
  }
  for (const m of text.matchAll(/\*\*([^*]{1,60})\*\*/g)) pushUnique(out, uiName(m[1]))
  // "File > Save As", "Settings → Privacy › Camera": every segment is a name.
  for (const m of text.matchAll(
    /([\p{L}\p{N}][^>→›\n.;:[\]]{0,40}?)(\s*(?:>|→|›)\s*[\p{L}\p{N}][^>→›\n.;:,[\]]{0,40})+/gu
  ))
    for (const part of m[0].split(/\s*(?:>|→|›)\s*/))
      // "Select File" → "File": drop a leading verb the path starts with.
      pushUnique(
        out,
        uiName(part.trim().replace(/^(select|click|choose|tap|go to|open|press)\s+/i, ''))
      )
  for (const m of text.matchAll(/["“]([^"”]{1,48})["”]/g)) pushUnique(out, uiName(m[1]))
  return out
}

function step(text: string, ui: string[], shortcut?: string): HowtoStep | null {
  const t = clean(text)
    .replace(/\s*\[(?:UI|keys):[^\]]*\]/gi, '')
    .replace(/\*\*/g, '')
  if (t.length < 3) return null
  return {
    text: t.length > MAX_STEP_CHARS ? `${t.slice(0, MAX_STEP_CHARS - 1)}…` : t,
    ui,
    ...(shortcut ? { shortcut } : {})
  }
}

/** Steps from plain text: numbered or bulleted lines, else nothing. */
export function stepsFromText(text: string): HowtoStep[] {
  const lines = text.split(/\r?\n/)
  const numbered = lines.filter((l) => /^\s*(?:\d{1,2}[.)]|step \d{1,2}:)\s+\S/i.test(l))
  const picked = numbered.length >= 1 ? numbered : lines.filter((l) => /^\s*[-*•]\s+\S/.test(l))
  const out: HowtoStep[] = []
  for (const l of picked) {
    const body = l.replace(/^\s*(?:\d{1,2}[.)]|step \d{1,2}:|[-*•])\s+/i, '')
    const keys = /\bkeys:\s*([^\]\n]+)/i.exec(body)?.[1]
    const s = step(body, uiNamesIn(body), shortcutIn(keys ?? body))
    if (s) out.push(s)
    if (out.length >= MAX_STEPS) break
  }
  return out
}

/** Steps from doc HTML: the first ordered list with 2+ items (bold = UI name, kbd = keys). */
export function stepsFromHtml(html: string): HowtoStep[] {
  const body = html.replace(
    /<(script|style|noscript|svg|template|nav|header|footer)[\s\S]*?<\/\1>/gi,
    ' '
  )
  for (const ol of body.matchAll(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi)) {
    const items = [...ol[1].matchAll(/<li\b[^>]*>([\s\S]*?)(?=<li\b|$)/gi)].map((m) => m[1])
    if (items.length < 2) continue
    const out: HowtoStep[] = []
    for (const li of items) {
      const ui: string[] = []
      for (const m of li.matchAll(
        /<(strong|b|span class="ui[^"]*")[^>]*>([\s\S]*?)<\/(?:strong|b|span)>/gi
      ))
        pushUnique(ui, uiName(htmlToText(m[2])))
      const text = htmlToText(li)
      for (const n of uiNamesIn(text)) pushUnique(ui, n)
      const kbd = [...li.matchAll(/<kbd[^>]*>([\s\S]*?)<\/kbd>/gi)].map((m) => htmlToText(m[1]))
      const s = step(text.split('\n')[0] ?? text, ui, shortcutIn(kbd.join('+')) ?? shortcutIn(text))
      if (s) out.push(s)
      if (out.length >= MAX_STEPS) break
    }
    if (out.length >= 2) return out
  }
  return []
}

/** The UI names of a list of steps, in order, deduplicated (the grounding targets). */
export function groundingNames(steps: HowtoStep[]): string[] {
  const out: string[] = []
  for (const s of steps)
    for (const n of s.ui) if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n)
  return out
}

/** Steps as compact lines for a model or an answer card. */
export function formatSteps(steps: HowtoStep[]): string {
  return steps
    .map((s, i) => {
      const ui = s.ui.length ? ` [UI: ${s.ui.join('; ')}]` : ''
      const keys = s.shortcut ? ` [keys: ${s.shortcut}]` : ''
      return `${i + 1}. ${s.text}${ui}${keys}`
    })
    .join('\n')
}
