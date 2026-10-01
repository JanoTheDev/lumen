// "Want me to save this as a skill?" (11 F9, self-improvement like Claude's): after an agent
// task finishes, Lumen offers once to keep it as a skill when the same kind of task has now
// worked twice, or when the user had to correct the agent on the way. No nagging: each
// pattern is offered at most once, a "no" is remembered, "stop offering skills" turns it off.
// Runs are kept as hashed signatures only (no prompt words, no typed text), in
// ~/.ai-overlay/skills-proposals.json. Pure apart from the small store.
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { AgentRunTrace } from './authoring'

/** Runs that count as "the same task": at least this similar. */
export const SIMILAR_AT = 0.6
/** Offer when the task has now worked this many times. */
export const REPEAT_MIN = 2
const RUNS_MAX = 80
const PATTERNS_MAX = 200

const STOP = new Set(
  'a an and the to of for in on at my me i you it is be this that with from please can could would will lumen then also now just some my your our open'.split(
    ' '
  )
)

const h = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 10)

export interface RunSignature {
  /** Hashed content words of the request. */
  words: string[]
  /** Hashed tool/op/target keys of the steps. */
  actions: string[]
}

/** The words of a request that say what it is about (no numbers, quotes, addresses). */
export function requestWords(prompt: string): string[] {
  const plain = prompt
    .toLowerCase()
    .replace(/["“”][^"“”]*["“”]/g, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
  return [...new Set(plain.split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 16)
}

function stepKey(s: AgentRunTrace['steps'][number]): string {
  const target =
    s.element?.automationId ??
    s.element?.name ??
    s.text ??
    s.app ??
    (s.url ? safeHost(s.url) : '') ??
    ''
  return [s.tool, s.op ?? '', (s.combo ?? '').toLowerCase(), target.toLowerCase()].join(':')
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function runSignature(run: AgentRunTrace): RunSignature {
  return {
    words: requestWords(run.prompt).map(h),
    actions: [...new Set(run.steps.map(stepKey))].map(h)
  }
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 0
  const sb = new Set(b)
  const inter = a.filter((x) => sb.has(x)).length
  return inter / (new Set([...a, ...b]).size || 1)
}

/** 0-1: how alike two runs are (the request words and the steps they took). */
export function similarity(a: RunSignature, b: RunSignature): number {
  const w = jaccard(a.words, b.words)
  const x = jaccard(a.actions, b.actions)
  if (!a.actions.length || !b.actions.length) return w
  return Math.max(x, 0.5 * w + 0.5 * x)
}

interface Pattern {
  sig: RunSignature
  at: number
  answer: 'offered' | 'yes' | 'no'
}

export interface ProposalData {
  runs: { sig: RunSignature; at: number }[]
  patterns: Pattern[]
  off: boolean
  /** Skills told "needs an update" (cleared when the skill is changed). */
  noticed: string[]
}

const empty = (): ProposalData => ({ runs: [], patterns: [], off: false, noticed: [] })

export type ProposalReason = 'repeated' | 'corrected'

export interface ProposalVerdict {
  reason: ProposalReason
  sig: RunSignature
}

export class ProposalStore {
  data: ProposalData

  constructor(private readonly file: string | null) {
    this.data = empty()
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProposalData>
      const sigOk = (s: unknown): s is RunSignature =>
        !!s &&
        Array.isArray((s as RunSignature).words) &&
        Array.isArray((s as RunSignature).actions)
      this.data = {
        runs: (raw.runs ?? []).filter((r) => sigOk(r?.sig)).slice(-RUNS_MAX),
        patterns: (raw.patterns ?? []).filter((p) => sigOk(p?.sig)).slice(-PATTERNS_MAX),
        off: raw.off === true,
        noticed: (raw.noticed ?? []).filter((n) => typeof n === 'string').slice(0, 300)
      }
    } catch {
      // Missing or broken: start empty.
    }
  }

  /**
   * Records a finished run and says whether to offer it as a skill. Never for a run of a skill,
   * when switched off, or when this pattern was offered before (whatever the answer was).
   */
  consider(
    run: AgentRunTrace,
    opts: { corrected: boolean; covered: boolean; now: number }
  ): ProposalVerdict | null {
    const sig = runSignature(run)
    const earlier = this.data.runs.filter((r) => similarity(sig, r.sig) >= SIMILAR_AT).length
    this.data.runs = [...this.data.runs, { sig, at: opts.now }].slice(-RUNS_MAX)
    this.save()
    if (this.data.off || run.skill || opts.covered || !run.steps.length) return null
    if (this.data.patterns.some((p) => similarity(sig, p.sig) >= SIMILAR_AT)) return null
    if (opts.corrected) return { reason: 'corrected', sig }
    if (earlier + 1 >= REPEAT_MIN) return { reason: 'repeated', sig }
    return null
  }

  /** The offer was made (or answered): this pattern is never offered again. */
  answered(sig: RunSignature, answer: Pattern['answer'], now: number): void {
    const rest = this.data.patterns.filter((p) => similarity(sig, p.sig) < 0.999)
    this.data.patterns = [...rest, { sig, at: now, answer }].slice(-PATTERNS_MAX)
    this.save()
  }

  setOff(off: boolean): void {
    this.data.off = off
    this.save()
  }

  /** Whether "needs an update" was already said for this skill; marks it said. */
  noticeOnce(name: string): boolean {
    if (this.data.noticed.includes(name)) return false
    this.data.noticed = [...this.data.noticed, name].slice(-300)
    this.save()
    return true
  }

  /** The skill changed: a later run of drift may be noticed again. */
  clearNotice(name: string): void {
    if (!this.data.noticed.includes(name)) return
    this.data.noticed = this.data.noticed.filter((n) => n !== name)
    this.save()
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[skills] proposals not saved:', (e as Error).message)
    }
  }
}

/** The spoken offer. */
export function offerLine(reason: ProposalReason): string {
  return reason === 'corrected'
    ? 'That took a correction. Want me to save how it worked as a skill, so it goes right next time? Say yes or no.'
    : 'You have asked for this before. Want me to save it as a skill? Say yes or no.'
}

// ---- corrections during a task ----

const CORRECTION_RE =
  /^(?:no[,\s]|not (?:that|this|there)|wrong|that s wrong|that is wrong|i said|i meant|i mean|actually|instead|use the|the other|try (?:the|again)|go back|undo that|nope)/

/** Words the user says to a running task that read as a correction. */
export function isCorrection(utterance: string): boolean {
  const n = utterance
    .toLowerCase()
    .replace(/['’]/g, ' ')
    .replace(/[^a-z\s,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return n.length >= 2 && CORRECTION_RE.test(`${n} `)
}

// ---- answers to the offer ----

export type OfferAnswer = 'yes' | 'no' | 'never'

export function matchOfferAnswer(utterance: string): OfferAnswer | null {
  const n = utterance
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^(?:yes|yeah|yep|sure|ok|okay|please do|do it|save it|yes please|go ahead)$/.test(n))
    return 'yes'
  if (/^(?:no|nope|no thanks|not now|nah|no thank you|dont|skip it)$/.test(n)) return 'no'
  if (
    /^(?:never|stop (?:offering|asking)(?: (?:about |to save )?skills)?|dont (?:offer|ask)(?: that| about skills)? again)$/.test(
      n
    )
  )
    return 'never'
  return null
}

/** "start offering skills again" turns offers back on. */
export const OFFERS_ON_RE = /^(?:start|resume) (?:offering|suggesting) skills(?: again)?$/
