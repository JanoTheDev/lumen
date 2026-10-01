// Practice challenge flow (11 T22): start (model makes the challenge for the app and level),
// a timer that only says when time is up, "check my work" (one screenshot, sent only then),
// "give up", the streak. One challenge at a time; it survives a restart (kept in the store
// file) but its timer does not. Deps injected; no Electron.
import {
  challengeTurn,
  checkTurn,
  levelFor,
  parseChallengeCommand,
  spokenChallenge,
  spokenVerdict,
  streak,
  toChallenge,
  verdict,
  type Challenge,
  type ChallengeData,
  type ChallengeRecord,
  type CheckReply,
  type GenChallenge,
  type Level,
  MAX_HISTORY
} from './challenges'

export interface ChallengeApp {
  id: string
  name: string
}

export interface ChallengeDeps {
  now(): number
  /** The app in front (pack id, else process name). */
  foregroundApp(): Promise<ChallengeApp | null>
  /** "in blender" → the pack; null when unknown. */
  appByName(query: string): ChallengeApp | null
  /** What the skill tree knows about the user in this app. */
  learner(appId: string): { mastery: number | null; weak: string[]; done: string[] }
  readingLevel(appId: string): string
  generate(system: string, user: string): Promise<GenChallenge | null>
  capture(): Promise<{ data: string; mime: string } | null>
  /** The app bridge's state as text (Blender), else null. */
  appState(appId: string): Promise<string | null>
  judge(
    system: string,
    user: string,
    image: { data: string; mime: string }
  ): Promise<CheckReply | null>
  /** Mastery for the skill tags (07 progress). */
  practice(appId: string, skills: string[], quality: number): void
  load(): ChallengeData
  save(data: ChallengeData): void
  say(text: string): void
  /** The bar line while a challenge runs; null clears it. */
  showLine(text: string | null): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(msg: string): void
  handled: unknown
}

export type StartResult = { ok: true; challenge: Challenge } | { ok: false; error: string }

export interface ChallengeStatusView {
  active: (Challenge & { secondsLeft: number }) | null
  streak: number
  best: number
  passed: number
  recent: ChallengeRecord[]
}

type Reply = { mode: 'answer'; text: string }
const answer = (text: string): Reply => ({ mode: 'answer', text })

export class ChallengeRunner {
  private data: ChallengeData
  private timer: unknown = null
  private busy = false

  constructor(
    private readonly deps: ChallengeDeps,
    private readonly prompts: { generate: string; check: string }
  ) {
    this.data = deps.load()
  }

  active(): Challenge | null {
    return this.data.active ?? null
  }

  status(): ChallengeStatusView {
    const now = this.deps.now()
    const s = streak(this.data.history, now)
    const a = this.data.active
    return {
      active: a
        ? {
            ...a,
            secondsLeft: Math.max(0, Math.round((a.startedAt + a.minutes * 60_000 - now) / 1000))
          }
        : null,
      streak: s.current,
      best: s.best,
      passed: this.data.history.filter((r) => r.passed).length,
      recent: this.data.history.slice(-10).reverse()
    }
  }

  private persist(): void {
    this.deps.save(this.data)
  }

  private armTimer(c: Challenge): void {
    if (this.timer) this.deps.clearTimer(this.timer)
    const ms = c.startedAt + c.minutes * 60_000 - this.deps.now()
    if (ms <= 0) return
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      if (this.data.active?.id === c.id)
        this.deps.say('Time is up. Say “check my work” when you are ready, or keep going.')
    }, ms)
  }

  async start(
    opts: { app?: string; level?: Level | 'harder' | 'easier' } = {}
  ): Promise<StartResult> {
    if (this.busy) return { ok: false, error: 'already making one' }
    const app = opts.app ? this.deps.appByName(opts.app) : await this.deps.foregroundApp()
    if (!app)
      return {
        ok: false,
        error: opts.app ? `I don't know the app “${opts.app}”` : 'open the app first'
      }
    const learner = this.deps.learner(app.id)
    const last = [...this.data.history].reverse().find((r) => r.app === app.id)
    const level = levelFor(learner.mastery, opts.level, opts.level ? last?.level : undefined)
    this.busy = true
    this.deps.showLine(`Making a ${level} challenge for ${app.name}…`)
    try {
      const recent = this.data.history
        .filter((r) => r.app === app.id)
        .slice(-5)
        .map((r) => r.title)
      const user = challengeTurn({
        appName: app.name,
        level,
        weak: learner.weak,
        done: learner.done,
        recent,
        readingLevel: this.deps.readingLevel(app.id)
      })
      const g = await this.deps.generate(this.prompts.generate, user).catch((e: Error) => {
        this.deps.log(`challenge: generate failed (${e.message})`)
        return null
      })
      const c = toChallenge(g, { app: app.id, appName: app.name, level, now: this.deps.now() })
      if (!c) {
        this.deps.showLine(null)
        return { ok: false, error: 'I could not make a challenge this time' }
      }
      this.data = { ...this.data, active: c }
      this.persist()
      this.armTimer(c)
      this.deps.showLine(`Challenge: ${c.title} (${c.minutes} min). Say “check my work” when done.`)
      this.deps.log(`challenge ${c.id} started: ${app.id}, ${level}, ${c.rubric.length} checks`)
      return { ok: true, challenge: c }
    } finally {
      this.busy = false
    }
  }

  async check(): Promise<{ ok: boolean; text: string }> {
    const c = this.data.active
    if (!c) return { ok: false, text: 'There is no challenge running. Say “give me a challenge”.' }
    if (this.busy) return { ok: false, text: 'Still checking.' }
    this.busy = true
    this.deps.showLine('Checking your work…')
    try {
      const image = await this.deps.capture()
      if (!image) return { ok: false, text: 'I could not see the screen.' }
      const state = await this.deps.appState(c.app).catch(() => null)
      const reply = await this.deps
        .judge(this.prompts.check, checkTurn(c, state, this.deps.readingLevel(c.app)), image)
        .catch((e: Error) => {
          this.deps.log(`challenge: check failed (${e.message})`)
          return null
        })
      if (!reply) {
        this.deps.showLine(`Challenge: ${c.title}`)
        return { ok: false, text: 'I could not check it this time. Try “check my work” again.' }
      }
      const v = verdict(c, reply)
      const now = this.deps.now()
      const overTime = now > c.startedAt + c.minutes * 60_000
      const rec: ChallengeRecord = {
        id: c.id,
        app: c.app,
        title: c.title,
        level: c.level,
        startedAt: c.startedAt,
        finishedAt: now,
        passed: v.passed,
        met: v.met,
        total: v.total,
        overTime,
        feedback: v.feedback
      }
      if (c.skills.length) this.deps.practice(c.app, c.skills, v.quality)
      // A pass ends the challenge; otherwise it stays on to try again.
      this.data = {
        version: 1,
        history: [...this.data.history, rec].slice(-MAX_HISTORY),
        ...(v.passed ? {} : { active: c })
      }
      this.persist()
      if (v.passed) this.end()
      else this.deps.showLine(`Challenge: ${c.title}. Fix it and say “check my work” again.`)
      const s = streak(this.data.history, now)
      const streakLine = v.passed && s.current > 1 ? ` That's ${s.current} days in a row.` : ''
      this.deps.log(`challenge ${c.id}: ${v.met}/${v.total}${v.passed ? ' passed' : ''}`)
      return { ok: true, text: `${spokenVerdict(v, overTime)}${streakLine}` }
    } finally {
      this.busy = false
    }
  }

  stop(): boolean {
    if (!this.data.active) return false
    this.data = { version: 1, history: this.data.history }
    this.persist()
    this.end()
    return true
  }

  private end(): void {
    if (this.timer) this.deps.clearTimer(this.timer)
    this.timer = null
    this.deps.showLine(null)
  }

  /** After a restart: the challenge left running gets its timer back. */
  resume(): void {
    const c = this.data.active
    if (c) this.armTimer(c)
  }

  intercept(utterance: string): unknown | undefined {
    const cmd = parseChallengeCommand(utterance, !!this.data.active)
    if (!cmd) return undefined
    switch (cmd.kind) {
      case 'start':
        return this.start({ app: cmd.app, level: cmd.level }).then((r) =>
          r.ok ? answer(spokenChallenge(r.challenge)) : answer(`No challenge: ${r.error}.`)
        )
      case 'check':
        return this.check().then((r) => answer(r.text))
      case 'stop':
        this.stop()
        return answer('Challenge stopped. Say “give me a challenge” for a new one.')
      case 'repeat':
        return answer(spokenChallenge(this.data.active!))
      case 'time': {
        const left = this.status().active?.secondsLeft ?? 0
        return answer(
          left > 0
            ? `${Math.ceil(left / 60)} ${Math.ceil(left / 60) === 1 ? 'minute' : 'minutes'} left.`
            : 'Time is up, but you can keep going.'
        )
      }
      case 'streak': {
        const s = this.status()
        return answer(
          s.passed
            ? `Your streak is ${s.streak} ${s.streak === 1 ? 'day' : 'days'}; your best is ${s.best}. You have passed ${s.passed} challenges.`
            : 'No challenges passed yet. Say “give me a challenge” to start.'
        )
      }
    }
  }
}
