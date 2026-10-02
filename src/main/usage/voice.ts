// Usage questions by voice (05 T45): "how much did I spend this week", "what used the most
// tokens today", "how much does my morning automation cost", "how much has Inbox Buddy cost".
// Local grammar on the whole utterance and an answer built from the usage ledger; no model call.
// `parseUsageQuestion` and `answerUsageQuestion` are pure (rows and names passed in).
import type { ModelResponse } from '@shared/types'
import {
  queryUsage,
  startOfDay,
  startOfMonth,
  sumBy,
  totals,
  type UsageRow,
  type UsageTotals
} from './ledger'
import { limitState, money, tokenWords, type LimitState } from './limits'

export type UsageWhen = 'today' | 'yesterday' | 'week' | 'last7' | 'month' | 'last-month' | 'last30'

export type UsageQuestion =
  | { kind: 'spend'; when: UsageWhen }
  | { kind: 'top'; when: UsageWhen; by: 'tokens' | 'cost' }
  | { kind: 'named'; name: string; when: UsageWhen; hint?: 'automation' | 'buddy' }

export interface NamedScope {
  kind: 'automation' | 'buddy'
  id: string
  name: string
}

const WHEN_RE =
  /\b(today|so far today|yesterday|this week|last week|(?:in )?the (?:last|past) (?:7|seven) days|this month|so far this month|last month|(?:in )?the (?:last|past) (?:30|thirty) days)\b/

function whenOf(text: string, fallback: UsageWhen): UsageWhen {
  const m = WHEN_RE.exec(text)?.[1] ?? ''
  if (!m) return fallback
  if (m.includes('today')) return 'today'
  if (m === 'yesterday') return 'yesterday'
  if (m === 'this week') return 'week'
  if (m === 'last week' || /7|seven/.test(m)) return 'last7'
  if (m.includes('this month')) return 'month'
  if (m === 'last month') return 'last-month'
  return 'last30'
}

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^(?:hey lumen|lumen)[, ]+/, '')
    .replace(/[?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const WHEN_TAIL =
  '(?:\\s+(?:so far )?(?:today|yesterday|this week|last week|this month|last month|(?:in )?the (?:last|past) (?:7|seven|30|thirty) days))?'
/** "on AI", "on Lumen", "on models": spend that is Lumen's. Any other "on X" is not ours. */
const ON_US = '(?:\\s+on (?:ai|lumen|the ai|models|tokens|ai models|usage))?'

const SPEND_RES: RegExp[] = [
  new RegExp(
    `^how much (?:money )?(?:did|have) i (?:spend|spent|used?)${ON_US}(?: (?:so far|in total))?${WHEN_TAIL}${ON_US}$`
  ),
  new RegExp(
    `^how much (?:did|has|does) (?:lumen|the ai|ai) cost(?: me)?(?: so far)?${WHEN_TAIL}$`
  ),
  new RegExp(
    `^what(?:'s| is| did| have)? (?:i |my )?(?:spent|spend|spending|usage|ai spend|ai usage)${ON_US}${WHEN_TAIL}$`
  ),
  new RegExp(`^how many tokens (?:did|have) i (?:use|used)${WHEN_TAIL}$`)
]

const TOP_RES: RegExp[] = [
  new RegExp(
    `^what(?:'s| is| has)? (?:used|using|use|been using) the most (tokens|money)${WHEN_TAIL}$`
  ),
  new RegExp(`^what (?:cost|costs|has cost|was) the most(?: money)?${WHEN_TAIL}$`),
  new RegExp(`^what (?:used|uses|is using) (?:the )?most of my (tokens|money|budget)${WHEN_TAIL}$`)
]

const NAMED_RES: RegExp[] = [
  // "how much does my morning automation cost", "how much has Inbox Buddy cost this month"
  new RegExp(
    `^how much (?:does|did|has|do) (?:my |the )?(.{2,60}?) cost(?: me)?(?: so far)?${WHEN_TAIL}$`
  ),
  new RegExp(
    `^how much (?:have|has|did) (?:my |the )?(.{2,60}?) (?:spent|spend|used)${WHEN_TAIL}$`
  ),
  new RegExp(`^what (?:does|did|has) (?:my |the )?(.{2,60}?) cost(?: me)?(?: so far)?${WHEN_TAIL}$`)
]

const NOT_NAMES = new Set(['it', 'that', 'this', 'lumen', 'the ai', 'ai', 'i', 'everything', 'you'])

/** The question, or null when the words are not a usage question. */
export function parseUsageQuestion(raw: string): UsageQuestion | null {
  const text = clean(raw)
  if (!text || text.length > 160) return null
  for (const re of SPEND_RES)
    if (re.test(text)) return { kind: 'spend', when: whenOf(text, 'month') }
  for (const re of TOP_RES) {
    const m = re.exec(text)
    if (m) {
      return { kind: 'top', when: whenOf(text, 'today'), by: m[1] === 'tokens' ? 'tokens' : 'cost' }
    }
  }
  for (const re of NAMED_RES) {
    const m = re.exec(text)
    if (!m) continue
    let name = m[1].trim()
    if (NOT_NAMES.has(name)) return null
    let hint: 'automation' | 'buddy' | undefined
    // Only these words say "an automation / a buddy of mine"; without one the name must be whole.
    const tail = /\s+(automation|routine)s?$/.exec(name)
    if (tail) {
      hint = 'automation'
      name = name.slice(0, tail.index).trim()
    } else if (/\bbuddy$/.test(name)) hint = 'buddy'
    if (!name) return null
    return { kind: 'named', name, when: whenOf(text, 'month'), ...(hint ? { hint } : {}) }
  }
  return null
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

const KIND_WORDS = new Set(['buddy', 'automation'])
const bare = (ws: string[]): string => ws.filter((w) => !KIND_WORDS.has(w)).join(' ')

/**
 * The automation or buddy the words name: an exact name first (with or without "buddy" /
 * "automation"), then, only when the user said "automation", "routine" or "buddy" (`hint`), the
 * one sharing the most words (all of the spoken words must be in the name). Without that word a
 * partial name ("how much does Netflix cost") is a shopping question, not ours. Null when none or
 * a tie.
 */
export function matchNamed(
  q: { name: string; hint?: 'automation' | 'buddy' },
  scopes: NamedScope[]
): NamedScope | null {
  const said = words(q.name)
  if (!said.length) return null
  const pool = q.hint ? scopes.filter((s) => s.kind === q.hint) : scopes
  const exact = pool.filter((s) => words(s.name).join(' ') === said.join(' '))
  if (exact.length === 1) return exact[0]
  const whole = bare(said)
  const nearly = whole ? pool.filter((s) => bare(words(s.name)) === whole) : []
  if (nearly.length === 1) return nearly[0]
  if (!q.hint) return null
  let best: NamedScope | null = null
  let bestScore = 0
  let tie = false
  for (const s of pool) {
    const name = words(s.name)
    // "buddy" in the words is how the user addresses it, not part of the match.
    const needed = said.filter((w) => !(s.kind === 'buddy' && w === 'buddy'))
    if (!needed.length || !needed.every((w) => name.includes(w))) continue
    const score = needed.length / name.length
    if (score > bestScore) {
      best = s
      bestScore = score
      tie = false
    } else if (score === bestScore) tie = true
  }
  return tie ? null : best
}

/** [from, to) of the period, local time. */
export function rangeOf(when: UsageWhen, now: Date): { from: number; to: number } {
  const to = now.getTime() + 1
  const today = startOfDay(now)
  const dayMs = (n: number): number =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).getTime()
  switch (when) {
    case 'today':
      return { from: today.getTime(), to }
    case 'yesterday':
      return { from: dayMs(1), to: today.getTime() }
    case 'week': {
      const back = (today.getDay() + 6) % 7 // Monday starts the week
      return { from: dayMs(back), to }
    }
    case 'last7':
      return { from: dayMs(6), to }
    case 'last30':
      return { from: dayMs(29), to }
    case 'month':
      return { from: startOfMonth(now).getTime(), to }
    case 'last-month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      return { from: start.getTime(), to: startOfMonth(now).getTime() }
    }
  }
}

const WHEN_WORDS: Record<UsageWhen, string> = {
  today: 'today',
  yesterday: 'yesterday',
  week: 'this week',
  last7: 'in the last 7 days',
  month: 'this month',
  'last-month': 'last month',
  last30: 'in the last 30 days'
}

const FEATURE_WORDS: Record<string, string> = {
  answer: 'answers',
  'agent-step': 'agent tasks',
  router: 'understanding requests',
  describe: 'describing the screen',
  research: 'research',
  'how-to': 'how-to lookups',
  'dictation-cleanup': 'dictation',
  dictation: 'dictation',
  stt: 'speech to text',
  tts: 'spoken replies',
  summarize: 'summaries',
  news: 'news',
  'skill-write': 'writing skills',
  memory: 'memory',
  label: 'labels',
  lesson: 'lessons',
  verify: 'checking steps',
  refine: 'finding targets'
}

const featureWords = (f: string): string =>
  FEATURE_WORDS[f] ?? (f.startsWith('subagent-') ? 'helpers' : f.replace(/-/g, ' '))

const tok = (t: UsageTotals): number => t.in + t.out

function amount(t: UsageTotals): string {
  if (t.usd > 0) return `${money(t.usd)} (${tokenWords(tok(t))})`
  return tokenWords(tok(t))
}

function capLine(st: LimitState | null, own: boolean): string {
  if (!st || st.level === 'none') return ''
  const pct = Math.floor(st.ratio * 100)
  const whose = own ? 'its' : 'your'
  const cap = st.cap.usd !== undefined ? money(st.cap.usd) : tokenWords(st.cap.tokens ?? 0)
  if (st.level === 'paused') return ` That's past ${whose} monthly limit of ${cap}, so it's paused.`
  return ` That's ${pct}% of ${whose} monthly limit of ${cap}.`
}

export interface AnswerSources {
  rows(from: number, to: number): UsageRow[]
  scopes(): NamedScope[]
  limit(scope: { kind: 'overall' } | NamedScope): LimitState | null
  now(): Date
}

/** The short answer (spoken and on the card). */
export function answerUsageQuestion(q: UsageQuestion, src: AnswerSources): string | null {
  const now = src.now()
  const { from, to } = rangeOf(q.when, now)
  const when = WHEN_WORDS[q.when]
  if (q.kind === 'spend') {
    const t = totals(src.rows(from, to))
    if (!t.calls) return `Nothing used ${when}: no model calls yet.`
    const head =
      t.usd > 0
        ? `You spent about ${money(t.usd)} ${when}, ${tokenWords(tok(t))} over ${t.calls} ${t.calls === 1 ? 'call' : 'calls'}.`
        : `${when[0].toUpperCase()}${when.slice(1)} Lumen used ${tokenWords(tok(t))} over ${t.calls} ${t.calls === 1 ? 'call' : 'calls'}, all free.`
    const unpriced = t.unpriced ? ` ${t.unpriced} of them had no known price.` : ''
    const month = q.when === 'month' || q.when === 'today' || q.when === 'week'
    return head + unpriced + (month ? capLine(src.limit({ kind: 'overall' }), false) : '')
  }
  if (q.kind === 'top') {
    const rows = src.rows(from, to)
    if (!totals(rows).calls) return `Nothing used ${when}.`
    const groups = sumBy(rows, 'feature')
    if (q.by === 'tokens') groups.sort((a, b) => tok(b.totals) - tok(a.totals))
    const top = groups.slice(0, 3)
    const first = top[0]
    let text = `${q.by === 'tokens' ? 'Most tokens' : 'Most spend'} ${when}: ${featureWords(first.key)}, ${amount(first.totals)}.`
    if (top.length > 1)
      text += ` Then ${top
        .slice(1)
        .map((g) => `${featureWords(g.key)}, ${amount(g.totals)}`)
        .join('; ')}.`
    const named = src.scopes()
    const owners = [
      ...sumBy(rows, 'automationId').map((g) => ({ g, kind: 'automation' as const })),
      ...sumBy(rows, 'buddyId').map((g) => ({ g, kind: 'buddy' as const }))
    ].sort((a, b) =>
      q.by === 'tokens' ? tok(b.g.totals) - tok(a.g.totals) : b.g.totals.usd - a.g.totals.usd
    )
    const owner = owners[0]
    if (owner) {
      const name = named.find((s) => s.kind === owner.kind && s.id === owner.g.key)?.name
      if (name) text += ` The biggest ${owner.kind} was ${name}, ${amount(owner.g.totals)}.`
    }
    return text
  }
  const scope = matchNamed(q, src.scopes())
  if (!scope) return null
  const filtered = src
    .rows(from, to)
    .filter((r) =>
      scope.kind === 'automation' ? r.automationId === scope.id : r.buddyId === scope.id
    )
  const t = totals(filtered)
  const label = scope.kind === 'automation' ? `Your ${scope.name} automation` : scope.name
  if (!t.calls) return `${label} hasn't used anything ${when}.`
  const runs = new Set(filtered.map((r) => r.parentTaskId ?? r.taskId).filter(Boolean)).size
  const perRun =
    runs > 1 && t.usd > 0 ? ` About ${money(t.usd / runs)} a run over ${runs} runs.` : ''
  const cost = t.usd > 0 ? `cost ${money(t.usd)}` : 'was free'
  return (
    `${label} ${cost} ${when}, ${tokenWords(tok(t))}.` +
    perRun +
    (q.when === 'month' ? capLine(src.limit(scope), true) : '')
  )
}

let scopesPort: () => NamedScope[] = () => []

/** Automation and buddy names for "how much does my X cost" (wired at start). */
export function setUsageVoiceScopes(fn: () => NamedScope[]): void {
  scopesPort = fn
}

let cardsFreshPort: () => boolean = () => false

/** Whether answer cards a follow-up could mean are on hand (wired at start). */
export function setUsageVoiceCardsFresh(fn: () => boolean): void {
  cardsFreshPort = fn
}

const liveCardsFresh = (): boolean => {
  try {
    return cardsFreshPort()
  } catch {
    return false
  }
}

const liveSources: AnswerSources = {
  rows: (from, to) => queryUsage({ from, to }),
  scopes: () => {
    try {
      return scopesPort()
    } catch {
      return []
    }
  },
  limit: (scope) => {
    try {
      return limitState(scope.kind === 'overall' ? scope : { kind: scope.kind, id: scope.id })
    } catch {
      return null
    }
  },
  now: () => new Date()
}

/** Words that make a question about Lumen's own spend, not the price of something. */
const SPEND_WORDS = /\b(?:spend|spent|spending|cost me|used|use|tokens|usage)\b/

/**
 * The pipeline's hook: a usage question answered from the ledger, else null. A named question
 * whose name matches no automation or buddy falls through. While answer cards are fresh
 * (`cardsFresh`), only a question with spend words is ours ("how much does the hotel cost" is
 * a card follow-up).
 */
export function usageTurn(
  text: string,
  src: AnswerSources = liveSources,
  cardsFresh: () => boolean = liveCardsFresh
): ModelResponse | null {
  const q = parseUsageQuestion(text)
  if (!q) return null
  if (!SPEND_WORDS.test(clean(text)) && cardsFresh()) return null
  const answer = answerUsageQuestion(q, src)
  if (!answer) return null
  return { mode: 'answer', text: answer, spoken: answer }
}
