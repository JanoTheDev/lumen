import { DICTATION_APP_KINDS, type DictationAppKind } from '@shared/config'

/** "basecamp = work" lines → the styleApps map. Unknown kinds are dropped. */
export function styleAppsFromText(text: string): Record<string, DictationAppKind> {
  const out: Record<string, DictationAppKind> = {}
  for (const line of text.split(/[\n,]/)) {
    const m = /^\s*(.+?)\s*[=:]\s*([a-z-]+)\s*$/i.exec(line)
    if (!m) continue
    const kind = m[2].toLowerCase() as DictationAppKind
    const app = m[1].trim().toLowerCase().slice(0, 80)
    if (app && DICTATION_APP_KINDS.includes(kind) && Object.keys(out).length < 100) out[app] = kind
  }
  return out
}

export function styleAppsToText(map: Readonly<Record<string, DictationAppKind>>): string {
  return Object.entries(map)
    .map(([app, kind]) => `${app} = ${kind}`)
    .join('\n')
}

export interface SpellRuleText {
  from: string
  to: string
}

/** "cube control = kubectl" lines → spell-as rules (04 T39). */
export function spellAsFromText(text: string): SpellRuleText[] {
  const out: SpellRuleText[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\s*(.+?)\s*(?:=>|->|→|=)\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const from = m[1].slice(0, 60)
    const to = m[2].slice(0, 60)
    if (!from || !to || seen.has(from.toLowerCase()) || out.length >= 300) continue
    seen.add(from.toLowerCase())
    out.push({ from, to })
  }
  return out
}

export function spellAsToText(rules: readonly SpellRuleText[]): string {
  return rules.map((r) => `${r.from} = ${r.to}`).join('\n')
}

/** "figma: Auto layout, Frame" lines → terms per app (04 T39). */
export function appDictionaryFromText(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([^:=]+?)\s*[:=]\s*(.+)$/.exec(line)
    if (!m) continue
    const app = m[1].trim().toLowerCase().slice(0, 80)
    if (!app || (!out[app] && Object.keys(out).length >= 100)) continue
    const list = (out[app] ??= [])
    for (const raw of m[2].split(',')) {
      const term = raw.trim().slice(0, 60)
      if (term && list.length < 200 && !list.includes(term)) list.push(term)
    }
    if (!list.length) delete out[app]
  }
  return out
}

export function appDictionaryToText(map: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(map)
    .map(([app, terms]) => `${app}: ${terms.join(', ')}`)
    .join('\n')
}
