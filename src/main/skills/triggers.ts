// Trigger matching (11 T03): a whole utterance against every enabled skill's trigger phrases
// and its spoken name ("use the clean downloads skill"), locally, before any model call.
// Exact after normalising, else fuzzy (edit distance on the normalised text). Skills of the
// foreground app get a small boost; two close hits ask "Did you mean X or Y?". Pure: the
// registry is read, nothing runs. Typical cost is well under a millisecond per skill.
import type { LoadedSkill, SkillRegistry } from './registry'

export interface TriggerContext {
  /** App-pack id of the foreground app. */
  app?: string | null
  /** Minimum similarity for a fuzzy hit (0-1). */
  threshold?: number
}

export type TriggerMatch =
  | { kind: 'skill'; name: string; phrase: string; score: number; exact: boolean }
  | { kind: 'ambiguous'; names: string[]; question: string }

const FILLERS =
  /^(?:(?:hey |ok |okay )?lumen|please|can you|could you|would you|i want to|lets|let us)\s+/
const TAIL = /\s+(?:please|for me|now)$/
const LEAD_VERBS = /^(?:run|use|start|do|launch|open)\s+(?:the\s+|my\s+)?/
const SKILL_WORD = /\s+skill$/
const DEFAULT_THRESHOLD = 0.85
/** Two hits closer than this are ambiguous. */
const AMBIGUOUS_GAP = 0.04
const APP_BOOST = 0.05
/** A skill for other apps still matches by phrase, a little less readily. */
const OTHER_APP_PENALTY = 0.05

/** Lowercase, punctuation out, fillers off both ends. */
export function normalizeUtterance(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (let prev = ''; prev !== t; ) {
    prev = t
    t = t.replace(FILLERS, '').replace(TAIL, '').trim()
  }
  return t
}

/** The forms an utterance may take for a phrase: as said, and without "run ... skill". */
function forms(norm: string): string[] {
  const bare = norm.replace(LEAD_VERBS, '').replace(SKILL_WORD, '').trim()
  return bare && bare !== norm ? [norm, bare] : [norm]
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const n = Math.max(a.length, b.length)
  if (!n) return 1
  // Cheap reject before the O(n*m) distance.
  if (Math.abs(a.length - b.length) / n > 0.3) return 0
  return 1 - levenshtein(a, b) / n
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

function phrasesOf(s: LoadedSkill): string[] {
  const own = s.manifest.triggers.map(normalizeUtterance).filter(Boolean)
  return [...own, s.manifest.name.replace(/-/g, ' ')]
}

interface Scored {
  skill: LoadedSkill
  phrase: string
  score: number
  raw: number
}

/** The skill a whole utterance names, an ambiguity question, or null. */
export function matchSkillTrigger(
  text: string,
  registry: SkillRegistry,
  ctx: TriggerContext = {}
): TriggerMatch | null {
  const norm = normalizeUtterance(text)
  if (norm.length < 2 || norm.length > 120) return null
  const said = forms(norm)
  const threshold = ctx.threshold ?? DEFAULT_THRESHOLD
  const best = new Map<string, Scored>()
  for (const skill of registry.enabled()) {
    const own = new Set(skill.manifest.triggers.map(normalizeUtterance))
    for (const phrase of phrasesOf(skill)) {
      // The bare skill name only counts with "run/use ... (skill)" or said alone.
      for (const f of own.has(phrase) ? said : [said[said.length - 1]]) {
        const raw = similarity(f, phrase)
        if (raw < threshold) continue
        const apps = skill.manifest.apps
        const adj =
          ctx.app && apps.includes(ctx.app) ? APP_BOOST : apps.length ? -OTHER_APP_PENALTY : 0
        const score = raw + adj
        const prev = best.get(skill.manifest.name)
        if (!prev || score > prev.score)
          best.set(skill.manifest.name, { skill, phrase, score, raw })
      }
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score)
  if (!ranked.length) return null
  const [top, second] = ranked
  const exact = top.raw === 1
  const secondExact = second?.raw === 1
  if (second && exact === secondExact && top.score - second.score < AMBIGUOUS_GAP) {
    const names = ranked
      .filter((r) => top.score - r.score < AMBIGUOUS_GAP)
      .slice(0, 3)
      .map((r) => r.skill.manifest.name)
    const spoken = names.map((n) => n.replace(/-/g, ' '))
    const question = `Did you mean ${spoken.slice(0, -1).join(', ')} or ${spoken[spoken.length - 1]}?`
    return { kind: 'ambiguous', names, question }
  }
  return {
    kind: 'skill',
    name: top.skill.manifest.name,
    phrase: top.phrase,
    score: Math.min(1, top.score),
    exact
  }
}
