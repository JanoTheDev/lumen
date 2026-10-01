// Practice challenges (11 T22, F10): a short hands-on exercise in the user's own app ("make a
// mug in under 10 minutes"), made by the fast model for the app and the user's level (07
// mastery), checked on request from one screenshot (plus the app bridge's state when there is
// one) against a short rubric, with specific feedback. Results feed the skill tree's mastery
// and a daily streak; all kept on this PC (~/.ai-overlay/teach/challenges.json). Pure: no
// Electron, no fs (the store is injected).
import { z } from 'zod'
import { UNTRUSTED_CONTENT_RULE } from '../ai/prompts/untrusted'
import { localDay, addDays } from './srs'

export type Level = 'beginner' | 'intermediate' | 'advanced'
export const LEVELS: Level[] = ['beginner', 'intermediate', 'advanced']

export interface Challenge {
  id: string
  app: string
  appName: string
  title: string
  goal: string
  setup: string
  level: Level
  minutes: number
  /** Skill tags (lesson tags) it practises: mastery moves for these. */
  skills: string[]
  rubric: string[]
  startedAt: number
}

export interface ChallengeRecord {
  id: string
  app: string
  title: string
  level: Level
  startedAt: number
  finishedAt: number
  passed: boolean
  met: number
  total: number
  overTime: boolean
  feedback: string
}

export interface ChallengeData {
  version: 1
  active?: Challenge
  history: ChallengeRecord[]
}

export const MAX_HISTORY = 200
export const emptyChallenges = (): ChallengeData => ({ version: 1, history: [] })

export function migrateChallenges(raw: unknown): ChallengeData {
  const d = raw as Partial<ChallengeData> | null
  if (!d || d.version !== 1 || !Array.isArray(d.history)) return emptyChallenges()
  return {
    version: 1,
    history: d.history.slice(-MAX_HISTORY),
    ...(d.active?.rubric?.length ? { active: d.active } : {})
  }
}

// ---- Streak ----

/** Days in a row (ending today or yesterday) with at least one passed challenge; and the best. */
export function streak(history: ChallengeRecord[], now: number): { current: number; best: number } {
  const days = [
    ...new Set(history.filter((r) => r.passed).map((r) => localDay(r.finishedAt)))
  ].sort()
  let best = 0
  let run = 0
  let prev = ''
  for (const d of days) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1
    best = Math.max(best, run)
    prev = d
  }
  const today = localDay(now)
  const last = days[days.length - 1]
  const current = last === today || last === addDays(today, -1) ? run : 0
  return { current, best }
}

// ---- Level ----

/** Average mastery (0-1) of the app's skill tags, null when nothing is known yet. */
export function appMastery(mastery: Record<string, number>, app: string): number | null {
  const vals = Object.entries(mastery)
    .filter(([k]) => k.startsWith(`${app}:`))
    .map(([, v]) => v)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

/** The app's weakest skill tags first (at most `n`). */
export function weakSkills(mastery: Record<string, number>, app: string, n = 3): string[] {
  return Object.entries(mastery)
    .filter(([k]) => k.startsWith(`${app}:`))
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .map(([k]) => k.slice(app.length + 1))
}

export function levelFor(
  mastery: number | null,
  ask?: Level | 'harder' | 'easier',
  last?: Level
): Level {
  if (ask && ask !== 'harder' && ask !== 'easier') return ask
  let base: Level =
    last ??
    (mastery === null || mastery < 0.45 ? 'beginner' : mastery < 0.75 ? 'intermediate' : 'advanced')
  if (ask) {
    const i = LEVELS.indexOf(base) + (ask === 'harder' ? 1 : -1)
    base = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i))]
  }
  return base
}

// ---- Model: make a challenge ----

export const CHALLENGE_SYSTEM = `You write one short hands-on practice challenge for someone learning a desktop app.
Rules:
- It is done in the user's own copy of the app, on what is already on their PC: no downloads, accounts, purchases, sending anything, or deleting their files.
- It fits the level and the time, and practises the weak skills when given. Not the same as recent challenges.
- goal: one or two plain sentences saying what to make or do, spoken aloud, no markdown.
- setup: one sentence on how to start (e.g. "Start a new file."), or "".
- rubric: 2 to 5 short checks that are visible on the screen at the end, each one fact ("A cylinder is in the scene", "The cup has a handle").
- skills: 1 to 3 skill words from the given list, or short new ones.
- minutes: a whole number from 2 to 30.`

export const genChallengeSchema = z.object({
  title: z.string(),
  goal: z.string(),
  setup: z.string(),
  minutes: z.number(),
  skills: z.array(z.string()),
  rubric: z.array(z.string())
})
export type GenChallenge = z.infer<typeof genChallengeSchema>

export interface ChallengeTurn {
  appName: string
  level: Level
  weak: string[]
  done: string[]
  recent: string[]
  readingLevel: string
}

export function challengeTurn(t: ChallengeTurn): string {
  return [
    `App: ${t.appName}`,
    `Level: ${t.level}`,
    t.weak.length ? `Weak skills: ${t.weak.join(', ')}` : 'Weak skills: none known',
    t.done.length ? `Lessons done: ${t.done.slice(0, 12).join('; ')}` : 'Lessons done: none',
    t.recent.length ? `Recent challenges (do not repeat): ${t.recent.join('; ')}` : '',
    t.readingLevel
  ]
    .filter(Boolean)
    .join('\n')
}

const clean = (s: string, max: number): string => {
  const t = s
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** The model's challenge as a Challenge, or null when it is not usable. */
export function toChallenge(
  g: GenChallenge | null,
  ctx: { app: string; appName: string; level: Level; now: number }
): Challenge | null {
  if (!g) return null
  const goal = clean(g.goal, 300)
  const rubric = g.rubric
    .map((r) => clean(r, 120))
    .filter((r) => r.length >= 3)
    .slice(0, 5)
  if (goal.length < 8 || rubric.length < 2) return null
  const title = clean(g.title, 60) || clean(goal, 60)
  return {
    id: `ch-${ctx.now.toString(36)}`,
    app: ctx.app,
    appName: ctx.appName,
    title,
    goal,
    setup: clean(g.setup, 160),
    level: ctx.level,
    minutes: Math.round(Math.min(30, Math.max(2, Number.isFinite(g.minutes) ? g.minutes : 10))),
    skills: g.skills
      .map((s) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, '')
          .trim()
          .replace(/\s+/g, '-')
      )
      .filter(Boolean)
      .slice(0, 3),
    rubric,
    startedAt: ctx.now
  }
}

// ---- Model: check the work ----

export const CHECK_SYSTEM = `You check a practice challenge from a screenshot of the user's screen (and, when given, the app's exact state).
For each numbered rubric item say whether it is met (true only when you can see it or the state shows it) and a short specific note on what you see.
feedback: two or three plain spoken sentences: what went well, the one most useful thing to fix or try next, specific to what is on screen. Kind, never vague, no markdown.
${UNTRUSTED_CONTENT_RULE}`

export const checkReplySchema = z.object({
  items: z.array(z.object({ n: z.number(), met: z.boolean(), note: z.string() })),
  feedback: z.string()
})
export type CheckReply = z.infer<typeof checkReplySchema>

export function checkTurn(c: Challenge, state: string | null, readingLevel: string): string {
  return [
    `App: ${c.appName}`,
    `Challenge: ${c.goal}`,
    'Rubric:',
    ...c.rubric.map((r, i) => `${i + 1}. ${r}`),
    state
      ? `<context>\napp state: ${state.slice(0, 2000)}\n</context>`
      : 'App state: not available',
    readingLevel
  ].join('\n')
}

export interface Verdict {
  met: number
  total: number
  passed: boolean
  /** 0-5, for mastery (SM-2 style quality). */
  quality: number
  feedback: string
  missed: string[]
}

/** Passed when at least two thirds of the rubric is met. */
export function verdict(c: Challenge, reply: CheckReply): Verdict {
  const total = c.rubric.length
  const metSet = new Set(reply.items.filter((i) => i.met).map((i) => i.n))
  const met = c.rubric.filter((_, i) => metSet.has(i + 1)).length
  const missed = c.rubric.filter((_, i) => !metSet.has(i + 1))
  return {
    met,
    total,
    passed: met / total >= 2 / 3,
    quality: Math.round((5 * met) / total),
    feedback: clean(reply.feedback, 500),
    missed
  }
}

export function spokenVerdict(v: Verdict, overTime: boolean): string {
  const head = v.passed
    ? `Challenge passed: ${v.met} of ${v.total} checks.`
    : `Not there yet: ${v.met} of ${v.total} checks.`
  const time = overTime ? ' It took longer than planned, which is fine.' : ''
  const miss =
    !v.passed && v.missed.length ? ` Still missing: ${v.missed.slice(0, 2).join('; ')}.` : ''
  return `${head}${time}${miss} ${v.feedback}`.trim()
}

// ---- Voice ----

export type ChallengeCommand =
  | { kind: 'start'; level?: Level | 'harder' | 'easier'; app?: string }
  | { kind: 'check' }
  | { kind: 'stop' }
  | { kind: 'repeat' }
  | { kind: 'time' }
  | { kind: 'streak' }

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[.!?,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const START =
  /^(?:(?:please )?(?:give me|start|i want|lets do|can i have|can i get|i would like)(?: a| another| one more)? |(?:a |another |one more ))?(?:(harder|easier|beginner|intermediate|advanced) )?(?:practice )?challenge(?: please)?(?: (?:in|for) (.+))?$/
const CHALLENGE_ME = /^challenge me(?: (?:in|on|with) (.+))?$/
const PRACTICE = /^(?:practice challenge|lets practice(?: (?:in|with) (.+))?)$/

/** `active`: a challenge is running (its commands are claimed only then). */
export function parseChallengeCommand(u: string, active: boolean): ChallengeCommand | null {
  const t = norm(u)
  const m = START.exec(t)
  if (m)
    return {
      kind: 'start',
      ...(m[1] ? { level: m[1] as Level } : {}),
      ...(m[2] ? { app: m[2] } : {})
    }
  const me = CHALLENGE_ME.exec(t) ?? PRACTICE.exec(t)
  if (me) return { kind: 'start', ...(me[1] ? { app: me[1] } : {}) }
  if (
    /^(?:whats|what is) my (?:challenge )?streak$|^my (?:challenge )?streak$|^how many challenges have i done$/.test(
      t
    )
  )
    return { kind: 'streak' }
  if (!active) return null
  if (
    /^(?:check my work|check (?:it|the challenge)|im done|i am done|done with (?:the|this) challenge|how did i do|finished)$/.test(
      t
    )
  )
    return { kind: 'check' }
  if (/^(?:stop|cancel|skip|end) (?:the |this )?challenge$|^give up$|^i give up$/.test(t))
    return { kind: 'stop' }
  if (
    /^(?:repeat the challenge|what was the challenge|whats the challenge|what is the challenge|read the challenge)$/.test(
      t
    )
  )
    return { kind: 'repeat' }
  if (/^(?:how much time (?:is left|do i have)|how long do i have|time left)$/.test(t))
    return { kind: 'time' }
  return null
}

export function spokenChallenge(c: Challenge): string {
  const setup = c.setup ? ` ${c.setup}` : ''
  return `${c.title}. ${c.goal}${setup} You have ${c.minutes} minutes. Say “check my work” when you are done, or “give up”.`
}
