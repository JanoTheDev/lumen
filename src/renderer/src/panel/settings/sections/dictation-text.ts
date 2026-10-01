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
