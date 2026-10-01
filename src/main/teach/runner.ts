// Effect runner for the lesson reducer (plans 07 lesson-engine.md). Owns the timers, the
// running checks and the resolved target; talks to the app only through Ports. No Electron.
import { PausableTimer, realClock, type Clock } from '../a11y/timings'
import { startCheck, newBudget, type CheckHandle } from './checks'
import { accepts, reduce } from './engine'
import {
  buildScene,
  describeDoIt,
  doItActions,
  fallbackWhy,
  performActions,
  firstSentences,
  stepState,
  successScene
} from './hints'
import type { LessonContext } from './context'
import type { Lesson } from './lesson'
import type { CheckResult, Ports, ResolvedTarget } from './ports'
import type { Skill } from './registry'
import {
  IDLE,
  isRunning,
  type LessonCommand,
  type LessonEffect,
  type LessonEvent,
  type LessonSource,
  type LessonState,
  type StepStats,
  type TimerId
} from './state'

export interface ProgressSink {
  save(state: LessonState): void
}

/** How long "do it for me" waits for the step's checks to confirm before trusting the run. */
export const DO_IT_CONFIRM_MS = 3000

export interface StartOptions {
  skill?: Skill | null
  source?: LessonSource
  stepIndex?: number
  autoStart?: boolean
  pace?: number
  stats?: Record<string, StepStats>
  /** Voice-only / switch users: offer "do it" from the start of every step (T21). */
  offerEarly?: boolean
}

export class LessonRunner {
  private s: LessonState = IDLE
  private skill: Skill | null = null
  private timers = new Map<TimerId, PausableTimer>()
  private holds = new Set<string>()
  private checks: CheckHandle | null = null
  /** Bumped on every step change and check restart; stale async results are dropped. */
  private token = 0
  private stepAbort = new AbortController()
  private resolved: ResolvedTarget | null = null
  /** Latest scene request; an older target lookup that finishes late draws nothing. */
  private sceneSeq = 0
  private listeners = new Set<(s: LessonState) => void>()
  /** Model answers to "why?", per lesson step, for the session. */
  private whyCache = new Map<string, string>()

  constructor(
    private readonly ports: Ports,
    private readonly opts: { clock?: Clock; progress?: ProgressSink } = {}
  ) {}

  private get clock(): Clock {
    return this.opts.clock ?? realClock
  }

  get state(): LessonState {
    return this.s
  }

  running(): boolean {
    return isRunning(this.s)
  }

  currentSkill(): Skill | null {
    return this.skill
  }

  onChange(fn: (s: LessonState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  context(): LessonContext | null {
    const l = this.s.lesson
    if (!this.running() || !l) return null
    return {
      app: this.skill?.name ?? l.app,
      lessonTitle: l.title,
      stepSay: l.steps[this.s.index].say
    }
  }

  start(lesson: Lesson, o: StartOptions = {}): void {
    this.skill = o.skill ?? null
    this.dispatch({
      type: 'start',
      lesson,
      skillId: o.skill?.id ?? lesson.app,
      source: o.source,
      stepIndex: o.stepIndex,
      autoStart: o.autoStart,
      pace: o.pace,
      stats: o.stats,
      offerEarly: o.offerEarly
    })
  }

  /** A voice/keyboard/switch command; false when it does nothing in this state. */
  command(c: LessonCommand): boolean {
    if (!accepts(this.s, c)) return false
    this.dispatch({ type: 'command', command: c })
    return true
  }

  accepts(c: LessonCommand): boolean {
    return accepts(this.s, c)
  }

  appBlurred(): void {
    this.dispatch({ type: 'app-blur' })
  }

  /** Hint and timeout timers pause while Lumen speaks or the user talks. */
  hold(reason: string, on: boolean): void {
    if (on) this.holds.add(reason)
    else this.holds.delete(reason)
    for (const t of this.timers.values()) {
      if (on) t.pause(reason)
      else t.resume(reason)
    }
  }

  dispatch(e: LessonEvent): void {
    const t = reduce(this.s, e)
    this.s = t.state
    for (const fx of t.effects) this.run(fx)
    for (const fn of this.listeners) fn(this.s)
  }

  private run(fx: LessonEffect): void {
    const { ports } = this
    switch (fx.type) {
      case 'say':
        ports.speak.say(fx.text, { interruptible: fx.interruptible })
        ports.announce.announce(fx.text, 'polite')
        return
      case 'point':
        void this.point(fx.step, fx.level)
        return
      case 'scene':
        this.sceneSeq++
        if (fx.scene === 'clear') {
          this.resolved = null
          ports.screen.emitScene(null)
        } else {
          const scene = successScene(this.resolved)
          if (scene) ports.screen.emitScene(scene)
        }
        return
      case 'assistant':
        ports.screen.emitState(fx.state)
        return
      case 'startChecks':
        this.startChecks(fx.step)
        return
      case 'evaluate':
        void this.evaluate(fx.step)
        return
      case 'cancelChecks':
        this.cancelChecks()
        return
      case 'startTimer':
        this.startTimer(fx.id, fx.ms)
        return
      case 'cancelTimer':
        this.timers.get(fx.id)?.clear()
        return
      case 'persist':
        this.opts.progress?.save(this.s)
        return
      case 'exec':
        void this.exec(fx.step, !!fx.perform)
        return
      case 'explain':
        void this.explain(fx.step)
        return
      case 'event': {
        const id = this.s.lesson?.id ?? ''
        if (fx.name === 'step-started') ports.events.stepStarted(id, fx.step)
        else if (fx.name === 'step-completed') ports.events.stepCompleted(id, fx.step)
        else if (fx.name === 'done') ports.events.done(id, fx.completed)
        return
      }
      case 'log':
        ports.log('step', `lesson ${this.s.lesson?.id}: ${fx.msg}`)
        return
    }
  }

  private startTimer(id: TimerId, ms: number): void {
    let t = this.timers.get(id)
    if (!t) {
      t = new PausableTimer(this.clock, 0)
      for (const r of this.holds) t.pause(r)
      this.timers.set(id, t)
    }
    t.start(ms, () => this.dispatch({ type: 'timer', id }))
  }

  private async point(step: number, level: number): Promise<void> {
    const lesson = this.s.lesson
    const st = lesson?.steps[step]
    if (!st) return
    const seq = ++this.sceneSeq
    let r: ResolvedTarget | null = null
    if (st.target) {
      r = await this.ports.target
        .resolveTarget(st.target, { skill: this.skill, signal: this.stepAbort.signal })
        .catch(() => null)
    }
    // Dropped when the step changed while resolving.
    if (seq !== this.sceneSeq || this.s.index !== step || !this.running()) return
    this.resolved = r
    this.ports.screen.emitScene(buildScene(st, level, r))
  }

  private startChecks(step: number): void {
    this.cancelChecks()
    const st = this.s.lesson?.steps[step]
    if (!st) return
    const token = ++this.token
    this.stepAbort = new AbortController()
    const handle = startCheck(st.check, {
      ports: this.ports,
      clock: this.clock,
      step: st,
      budget: newBudget(),
      log: (msg) => this.ports.log('verify', `lesson ${this.s.lesson?.id}/${st.id}: ${msg}`)
    })
    this.checks = handle
    void handle.result.then((res) => {
      if (res === 'pass' && token === this.token)
        this.dispatch({ type: 'check', step, result: res })
    })
  }

  private cancelChecks(): void {
    this.checks?.cancel()
    this.checks = null
    this.stepAbort.abort()
    this.token++
  }

  private async evaluate(step: number): Promise<CheckResult> {
    const handle = this.checks
    const token = this.token
    const res: CheckResult = handle
      ? await handle.evaluate().catch(() => 'unknown' as const)
      : 'unknown'
    if (token === this.token && this.s.index === step)
      this.dispatch({ type: 'check', step, result: res, forced: true })
    return res
  }

  /** Says why a step matters: the cached or model answer (≤ 2 sentences), else a fallback. */
  private async explain(step: number): Promise<void> {
    const lesson = this.s.lesson
    const st = lesson?.steps[step]
    if (!lesson || !st) return
    const key = `${lesson.id}/${st.id}`
    let text = this.whyCache.get(key)
    if (!text) {
      const answer = await this.ports.explain
        .why(lesson, st, this.skill, this.stepAbort.signal)
        .catch(() => null)
      text = answer?.trim() ? firstSentences(answer, 2) : undefined
      if (text) this.whyCache.set(key, text)
    }
    // Dropped when the lesson moved on while the model answered.
    if (this.s.lesson !== lesson || this.s.index !== step || !this.running()) return
    const say = text ?? fallbackWhy(lesson)
    this.ports.speak.say(say, { interruptible: true })
    this.ports.announce.announce(say, 'polite')
    if (this.s.phase === 'step.waiting') this.ports.screen.emitState(stepState(lesson, step, say))
  }

  private async exec(step: number, perform: boolean): Promise<void> {
    const st = this.s.lesson?.steps[step]
    if (!st) return
    const actions = perform ? performActions(st) : doItActions(st)
    const done = (ok: boolean, said?: string): void => {
      if (this.s.index === step && this.s.phase === 'doing-it')
        this.dispatch({ type: 'do-it-done', step, ok, said })
    }
    if (!actions) return done(false)
    const ok = await this.ports.exec
      .run(actions, { skill: this.skill, signal: this.stepAbort.signal })
      .catch(() => false)
    if (!ok) return done(false)
    // Give the step's checks a moment to see it; an undecided check trusts the run.
    const handle = this.checks
    let res: CheckResult = 'unknown'
    if (handle) {
      res = await Promise.race([
        handle.result,
        new Promise<CheckResult>((resolve) =>
          this.clock.setTimeout(() => resolve('unknown'), DO_IT_CONFIRM_MS)
        )
      ])
      if (res !== 'pass') res = await handle.evaluate().catch(() => 'unknown' as const)
    }
    if (res === 'fail') this.ports.log('verify', `lesson do-it: check still fails after run`)
    // "click it" is the user's own step: praise, not "I clicked it for you".
    done(res !== 'fail', perform ? undefined : describeDoIt(actions))
  }
}
