// Spoken names → the things the user made (tasks, automations, skills, buddies, guides,
// connectors, grants). Pure. Words are compared after dropping filler ("the", "my", …) and the
// kind's own noun ("task", "skill"); a word of four letters or more may have one misheard letter,
// and a plural fits its singular. The best tier wins: the whole name said (3), every word of it
// said in any order (2), or only some of its words said (1). Several at the best tier: ambiguous.
import { editDistance } from '../buddies/voice'

export interface Named {
  id: string
  name: string
  /** Other ways to say it (a skill's trigger phrases, a site's short name). */
  aliases?: readonly string[]
}

export interface NameMatch {
  ids: string[]
  /** 0: nothing fits. */
  tier: 0 | 1 | 2 | 3
}

const FILLER = new Set([
  'the',
  'my',
  'a',
  'an',
  'of',
  'to',
  'for',
  'in',
  'on',
  'and',
  'at',
  'with',
  'one',
  'that',
  'this',
  'please',
  'called',
  'named'
])

/** Lowercase content words ("good-morning" → good, morning). */
export function nameWords(s: string, noise: ReadonlySet<string> = new Set()): string[] {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER.has(w) && !noise.has(w))
}

function fits(heard: string, word: string): boolean {
  if (heard === word) return true
  if (heard === `${word}s` || word === `${heard}s`) return true
  if (heard.length >= 4 && word.length >= 4 && /^\p{L}+$/u.test(word))
    return editDistance(heard, word, 1) <= 1
  return false
}

function tierOf(said: string[], label: string[]): 0 | 1 | 2 | 3 {
  if (!said.length || !label.length) return 0
  if (said.length === label.length && said.every((w, i) => fits(w, label[i]))) return 3
  if (!said.every((w) => label.some((l) => fits(w, l)))) return 0
  return label.every((l) => said.some((w) => fits(w, l))) ? 2 : 1
}

/** The items a spoken name means, best tier only. */
export function matchNamed(
  spoken: string,
  items: readonly Named[],
  noise: ReadonlySet<string> = new Set()
): NameMatch {
  const said = nameWords(spoken, noise)
  let best: NameMatch = { ids: [], tier: 0 }
  if (!said.length) return best
  for (const it of items) {
    let t: 0 | 1 | 2 | 3 = 0
    for (const label of [it.name, ...(it.aliases ?? [])]) {
      const lt = tierOf(said, nameWords(label, noise))
      if (lt > t) t = lt
    }
    if (!t) continue
    if (t > best.tier) best = { ids: [it.id], tier: t }
    else if (t === best.tier && !best.ids.includes(it.id)) best.ids.push(it.id)
  }
  return best
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']
const WHICH_FILLER = new Set(['i', 'mean', 'oh', 'um', 'uh', 'yes', 'yeah', 'just', 'it', 'is'])

/**
 * The answer to "Which one: A or B?": an ordinal ("the second one") or a name that fits exactly
 * one of them. null when the reply is something else (a new request).
 */
export function resolveWhich(text: string, options: readonly Named[]): string | null {
  const said = nameWords(text).filter((w) => !WHICH_FILLER.has(w))
  if (!said.length) return null
  if (said.length === 1) {
    const i = ORDINALS.indexOf(said[0])
    if (i >= 0) return options[i]?.id ?? null
    if (said[0] === 'last') return options.at(-1)?.id ?? null
  }
  const m = matchNamed(said.join(' '), options)
  return m.ids.length === 1 ? m.ids[0] : null
}

/** "A", "A or B", "A, B or C". */
export function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

/** "A", "A and B", "A, B and C". */
export function andList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
