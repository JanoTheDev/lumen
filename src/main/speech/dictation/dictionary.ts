// Personal dictionary v2 (04 T39): global terms (config dictation.dictionary), terms per app
// (dictation.appDictionary: a process or site word → terms) and "spell as" rules
// (dictation.spellAs: what the recogniser hears → how it is written, "cube control" →
// "kubectl"). Spell-as rules run on the transcript before cleanup; terms fix casing after it
// and steer the cloud transcription prompt. The offline models take no hotword list (CTC /
// AED), so these rules are the offline equivalent. Pure, plus export / import of the lot.
import { z } from 'zod'
import type { AppConfig } from '../../config'
import type { FocusTarget } from './terminal-guard'

type DictationConfig = AppConfig['dictation']
export type SpellRule = DictationConfig['spellAs'][number]

export const MAX_APPS = 100
export const MAX_APP_TERMS = 200
export const MAX_RULES = 300
const MAX_TERM = 60

/** A user key (process, process without .exe, or a word of the window title) fits the target. */
export function appKeyMatches(
  key: string,
  target: Pick<FocusTarget, 'process' | 'title'>
): boolean {
  const k = key.trim().toLowerCase()
  if (!k) return false
  const proc = target.process.toLowerCase()
  return (
    k === proc ||
    k === proc.replace(/\.exe$/, '') ||
    (k.length >= 3 && target.title.toLowerCase().includes(k))
  )
}

/** Terms of every app entry that fits the target. */
export function appTermsFor(
  appDictionary: Readonly<Record<string, readonly string[]>> | undefined,
  target: Pick<FocusTarget, 'process' | 'title'>
): string[] {
  const out: string[] = []
  for (const [key, terms] of Object.entries(appDictionary ?? {}))
    if (appKeyMatches(key, target)) out.push(...terms)
  return out
}

/** Global terms first, then the app's, then the written side of spell-as rules; no duplicates. */
export function termsFor(
  cfg: Pick<DictationConfig, 'dictionary' | 'appDictionary' | 'spellAs'>,
  target: Pick<FocusTarget, 'process' | 'title'>
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const all = [
    ...cfg.dictionary,
    ...appTermsFor(cfg.appDictionary, target),
    ...(cfg.spellAs ?? []).map((r) => r.to)
  ]
  for (const raw of all) {
    const t = raw.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Applies "heard → written" rules as whole words, case-insensitive, longest phrase first. */
export function applySpellAs(text: string, rules: readonly SpellRule[] | undefined): string {
  if (!rules?.length) return text
  const sorted = [...rules]
    .filter((r) => r.from.trim() && r.to.trim())
    .sort((a, b) => b.from.length - a.from.length)
  let out = text
  for (const r of sorted) {
    const parts = r.from.trim().split(/\s+/).map(escapeRe)
    // Words may be split by a space or by punctuation the recogniser put in between.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[\\s,.-]+')}(?![\\p{L}\\p{N}])`, 'giu')
    out = out.replace(re, r.to.trim())
  }
  return out
}

/** Spell-as rules learned from respelling corrections ("Figmah" fixed to "Figma"). */
export function rulesFromCorrections(
  found: ReadonlyArray<{ from: string; to: string }>,
  learned: readonly string[]
): SpellRule[] {
  const out: SpellRule[] = []
  for (const c of found) {
    if (!learned.includes(c.to) || c.from.toLowerCase() === c.to.toLowerCase()) continue
    if (out.some((r) => r.from === c.from.toLowerCase())) continue
    out.push({ from: c.from.toLowerCase(), to: c.to })
  }
  return out
}

/** `rules` with `added` merged in; a rule for the same heard text is replaced. */
export function withRules(rules: readonly SpellRule[], added: readonly SpellRule[]): SpellRule[] {
  const keys = new Set(added.map((r) => r.from.trim().toLowerCase()))
  return [...rules.filter((r) => !keys.has(r.from.trim().toLowerCase())), ...added].slice(
    -MAX_RULES
  )
}

// ---- export / import ----

const term = z.string().trim().min(1).max(MAX_TERM)

export const dictionaryFileSchema = z.object({
  lumenDictionary: z.literal(1),
  dictionary: z.array(term).max(500).default([]),
  appDictionary: z
    .record(z.string().trim().min(1).max(80), z.array(term).max(MAX_APP_TERMS))
    .default({}),
  spellAs: z
    .array(z.object({ from: term, to: term }))
    .max(MAX_RULES)
    .default([])
})
export type DictionaryFile = z.infer<typeof dictionaryFileSchema>

export function exportDictionary(
  cfg: Pick<DictationConfig, 'dictionary' | 'appDictionary' | 'spellAs'>
): DictionaryFile {
  return {
    lumenDictionary: 1,
    dictionary: [...cfg.dictionary],
    appDictionary: { ...(cfg.appDictionary ?? {}) },
    spellAs: [...(cfg.spellAs ?? [])]
  }
}

export interface ImportResult {
  dictionary: string[]
  appDictionary: Record<string, string[]>
  spellAs: SpellRule[]
  added: number
}

/** Merges an imported file into the current lists (current entries stay; caps apply). */
export function mergeImport(
  cfg: Pick<DictationConfig, 'dictionary' | 'appDictionary' | 'spellAs'>,
  file: DictionaryFile
): ImportResult {
  let added = 0
  const dict = [...cfg.dictionary]
  const lower = new Set(dict.map((d) => d.toLowerCase()))
  for (const t of file.dictionary) {
    if (dict.length >= 500 || lower.has(t.toLowerCase())) continue
    dict.push(t)
    lower.add(t.toLowerCase())
    added++
  }
  const apps: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(cfg.appDictionary ?? {})) apps[k] = [...v]
  for (const [rawKey, terms] of Object.entries(file.appDictionary)) {
    const key = rawKey.toLowerCase()
    if (!apps[key] && Object.keys(apps).length >= MAX_APPS) continue
    const list = (apps[key] ??= [])
    for (const t of terms) {
      if (list.length >= MAX_APP_TERMS || list.some((x) => x.toLowerCase() === t.toLowerCase()))
        continue
      list.push(t)
      added++
    }
  }
  const have = new Set((cfg.spellAs ?? []).map((r) => r.from.toLowerCase()))
  const fresh = file.spellAs.filter((r) => !have.has(r.from.toLowerCase()))
  added += fresh.length
  const spellAs = [...(cfg.spellAs ?? []), ...fresh].slice(0, MAX_RULES)
  return { dictionary: dict, appDictionary: apps, spellAs, added }
}
