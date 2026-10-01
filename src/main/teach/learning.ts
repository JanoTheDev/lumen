// Learning features on top of the lesson engine (plans 07 T27-T29, T33): "what should I learn
// next", review runs and their once-a-day reminder, the next-lesson suggestion after a lesson,
// and the opt-in idle hint / coach mode. index.ts wires the real registry, store, runner and
// agent in; everything here goes through LearningDeps (tests use fakes). No Electron.
import type { ConfigV2 } from '@shared/config'
import { realClock, type Clock } from '../a11y/timings'
import {
  matchAppOnly,
  matchCoach,
  matchLearnNext,
  matchStartIt,
  matchStopReminding,
  parseLessonCommand
} from './commands'
import { nextLesson } from './curriculum'
import { IdleHintWatcher, idleAppEnabled, type IdleHintConfig, type IdleLesson } from './idle-hint'
import type { ProgressStore } from './progress'
import { hasMatchRules, type SkillRegistry, type Skill } from './registry'
import { mayPrompt, reviewFor, reviewLesson } from './review'
import type { LessonRunner, StartOptions } from './runner'

/** A suggestion ("start it") or review prompt ("review") stays answerable this long. */
export const SUGGESTION_TTL_MS = 5 * 60_000
export const REMINDER_POLL_MS = 15_000
/** The next-lesson line waits for the end-of-lesson summary to be read. */
export const NEXT_OFFER_DELAY_MS = 4500

type TeachConfig = ConfigV2['teach']

export interface WindowLike {
  process?: string
  exe?: string
  title?: string
}

export interface LearningDeps {
  registry(): SkillRegistry | null
  store(): ProgressStore | null
  runner(): LessonRunner | null
  config(): TeachConfig
  setReminders(on: boolean): void
  /** Starts a pack or user lesson by id from its intro. */
  startLesson(id: string): boolean
  /** Pacing for a run from the a11y settings. */
  pacing(): Pick<StartOptions, 'pace' | 'offerEarly'>
  /** The window in front (active-window info only), reusing one seen within maxAgeMs. */
  foreground(maxAgeMs: number): Promise<WindowLike | null>
  /** Seconds since the last input anywhere (OS idle time). */
  idleSeconds(): number
  /** A passive line in the assistant bar. */
  show(lessonId: string, text: string): void
  /** Spoken / screen reader / caption, per the user's output settings. */
  say(text: string): void
  log(msg: string): void
  /** The router's "handled, nothing to show" response. */
  handled: unknown
  clock?: Clock
}

export interface Suggestion {
  lessonId: string
  review: boolean
  at: number
}

const answer = (text: string): { mode: 'answer'; text: string } => ({ mode: 'answer', text })

export interface Learning {
  startReview(id: string): { ok: boolean; error?: string }
  intercept(utterance: string): unknown | undefined
  onLessonDone(lessonId: string, completed: boolean): void
  checkReminder(): Promise<void>
  idleHintsFor(skillId: string | null | undefined): boolean
  /** Config changed: start or stop the idle watcher. */
  sync(): void
  watcher: IdleHintWatcher
  coachMode(): boolean
  suggestion(): Suggestion | null
  install(): void
  stop(): void
}

export function createLearning(deps: LearningDeps): Learning {
  const clock = deps.clock ?? realClock
  let suggestion: Suggestion | null = null
  let coach = false
  let reminderTimer: unknown = null

  const isDone = (id: string): boolean =>
    (deps.store()?.get().lessons[id]?.completedAt.length ?? 0) > 0

  const appOf = (lessonId: string): string | null =>
    deps.registry()?.lesson(lessonId)?.skill.id ?? null

  async function foregroundSkill(maxAgeMs: number): Promise<Skill | null> {
    const w = await deps.foreground(maxAgeMs).catch(() => null)
    return deps.registry()?.matchApp(w) ?? null
  }

  /** Whether idle hints replace the timer ladder for a lesson of this app. */
  function idleHintsFor(skillId: string | null | undefined): boolean {
    const cfg = deps.config()
    return cfg.idleHint && idleAppEnabled(idleConfig(cfg), skillId ?? null)
  }

  const idleConfig = (cfg: TeachConfig): IdleHintConfig => ({
    enabled: cfg.idleHint,
    apps: cfg.idleHintApps,
    seconds: cfg.idleHintSec,
    voice: cfg.idleHintVoice
  })

  function suggest(lessonId: string, review: boolean): void {
    suggestion = { lessonId, review, at: clock.now() }
  }

  function freshSuggestion(): Suggestion | null {
    const s = suggestion
    return s && clock.now() - s.at < SUGGESTION_TTL_MS ? s : null
  }

  // ---- Reviews (T29) ----

  function startReview(id: string): { ok: boolean; error?: string } {
    const found = deps.registry()?.lesson(id)
    const runner = deps.runner()
    if (!found || !runner) return { ok: false, error: 'not found' }
    if (!isDone(id) && !deps.store()?.get().srs[id])
      return { ok: false, error: 'finish the lesson once before reviewing it' }
    suggestion = null
    runner.start(reviewLesson(found.lesson), {
      skill: found.skill,
      source: found.skill.source === 'user' ? 'user' : 'pack',
      ...deps.pacing(),
      review: true,
      idleHints: idleHintsFor(found.skill.id)
    })
    deps.log(`review of ${id} started`)
    return { ok: true }
  }

  /** One reminder poll: only asks for the window when a review is due and none was shown today. */
  async function checkReminder(): Promise<void> {
    const store = deps.store()
    const runner = deps.runner()
    if (!store || !runner || runner.running()) return
    const now = clock.now()
    if (!mayPrompt(store.get(), now, deps.config().reviewReminders)) return
    if (!Object.keys(store.get().srs).length) return
    const skill = await foregroundSkill(REMINDER_POLL_MS)
    if (!skill || runner.running()) return
    const due = reviewFor(store.get(), now, skill.id, appOf)
    const lesson = due && deps.registry()?.lesson(due.lessonId)?.lesson
    if (!due || !lesson) return
    store.markPrompted(now)
    suggest(due.lessonId, true)
    deps.show(
      due.lessonId,
      `Quick ${skill.name} review: ${lesson.title}. Say “review” to start, or “not now”.`
    )
    deps.log(`review reminder for ${due.lessonId}`)
  }

  // ---- What next (T28) ----

  function nextIn(skill: Skill): string {
    const next = nextLesson(skill.lessons, skill.curriculum, isDone)
    if (next) {
      suggest(next.id, false)
      return `Next in ${skill.name}: ${next.title}. Say “start it” to begin.`
    }
    const store = deps.store()
    const due = store ? reviewFor(store.get(), clock.now(), skill.id, appOf) : null
    const lesson = due && deps.registry()?.lesson(due.lessonId)?.lesson
    if (due && lesson) {
      suggest(due.lessonId, true)
      return `You have done every ${skill.name} lesson. A review of ${lesson.title} is due. Say “review” to start.`
    }
    return `You have done every ${skill.name} lesson. Ask “show me how” for anything else.`
  }

  /** The app "what should I learn next" means: named, running, in front, or last learned. */
  function learningApp(named: string | undefined): Skill | null {
    const reg = deps.registry()
    if (!reg) return null
    const apps = reg.all().filter(hasMatchRules)
    if (named) {
      const id = matchAppOnly(named, apps)
      return id ? reg.get(id) : null
    }
    const running = deps.runner()?.state.skillId
    if (running && deps.runner()?.running()) return reg.get(running)
    const lessons = deps.store()?.get().lessons ?? {}
    const last = Object.entries(lessons)
      .map(([id, r]) => ({ id, at: r.completedAt.at(-1) ?? 0 }))
      .sort((a, b) => b.at - a.at)
      .find((x) => x.at && appOf(x.id))
    return last ? reg.get(appOf(last.id)!) : null
  }

  // ---- Router hook ----

  function takeSuggestion(s: Suggestion): unknown {
    suggestion = null
    if (s.review) {
      const r = startReview(s.lessonId)
      return r.ok ? deps.handled : answer('I could not start that review.')
    }
    return deps.startLesson(s.lessonId) ? deps.handled : undefined
  }

  /**
   * Utterances for the learning features, after the running lesson's own commands: "start
   * it" / "review" / "not now" for a suggestion, "stop reminding me", "what should I learn
   * next", "coach mode on|off". Anything else → undefined.
   */
  function intercept(utterance: string): unknown | undefined {
    const runner = deps.runner()
    const running = !!runner?.running()
    const s = running ? null : freshSuggestion()
    if (s) {
      const cmd = parseLessonCommand(utterance)
      if (matchStartIt(utterance) || cmd === 'yes' || cmd === 'next' || cmd === 'resume')
        return takeSuggestion(s)
      if (cmd === 'no') {
        suggestion = null
        return deps.handled
      }
    }
    if (matchStopReminding(utterance)) {
      deps.setReminders(false)
      if (suggestion?.review) suggestion = null
      return answer(
        'Okay, no more review reminders. You can turn them on again in Settings, Lessons.'
      )
    }
    const next = matchLearnNext(utterance)
    if (next) {
      const skill = learningApp(next.app)
      const text = skill
        ? nextIn(skill)
        : next.app
          ? `I have no lessons for ${next.app} yet.`
          : 'Which app? Say “what should I learn next in” and the app name.'
      deps.say(text)
      return answer(text)
    }
    const c = matchCoach(utterance)
    if (c !== null) {
      if (c && !deps.config().idleHint)
        return answer('Coach mode needs idle hints. Turn them on in Settings, Lessons.')
      coach = c
      watcher.sync()
      deps.log(`coach mode ${c ? 'on' : 'off'}`)
      return answer(
        c
          ? `Coach mode on. If you stop for ${deps.config().idleHintSec} seconds, I will offer a tip.`
          : 'Coach mode off.'
      )
    }
    return undefined
  }

  // ---- After a lesson ----

  /** A finished lesson suggests the next unlocked one of its app (passive bar line). */
  function onLessonDone(lessonId: string, completed: boolean): void {
    const runner = deps.runner()
    if (!completed || !runner || runner.state.review || runner.state.source === 'generated') return
    const skill = deps.registry()?.lesson(lessonId)?.skill
    if (!skill || !hasMatchRules(skill)) return
    const next = nextLesson(skill.lessons, skill.curriculum, isDone)
    if (!next) return
    suggest(next.id, false)
    clock.setTimeout(() => {
      if (suggestion?.lessonId === next.id && !deps.runner()?.running())
        deps.show(
          next.id,
          `Next in ${skill.name}: ${next.title}. Say “start it” when you are ready.`
        )
    }, NEXT_OFFER_DELAY_MS)
  }

  // ---- Idle hint (T33) ----

  function idleLesson(): IdleLesson | null {
    const r = deps.runner()
    if (!r?.running() || !r.state.lesson) return null
    const skill = deps.registry()?.get(r.state.skillId ?? '')
    return {
      key: `${r.state.lesson.id}#${r.state.index}`,
      appId: r.state.skillId,
      waiting: r.state.phase === 'step.waiting' && r.state.idleHints,
      anyApp: !skill || skill.id === 'windows' || !hasMatchRules(skill)
    }
  }

  function coachHint(appId: string, voice: boolean): void {
    const skill = deps.registry()?.get(appId)
    if (!skill) return
    const next = nextLesson(skill.lessons, skill.curriculum, isDone)
    if (next) suggest(next.id, false)
    const text = next
      ? `Stuck in ${skill.name}? Say “show me how” and what you want to do, or “start it” for the lesson ${next.title}.`
      : `Stuck in ${skill.name}? Say “show me how” and what you want to do.`
    deps.show(next?.id ?? '', text)
    if (voice) deps.say(text)
  }

  const watcher = new IdleHintWatcher({
    config: () => idleConfig(deps.config()),
    idleSeconds: () => deps.idleSeconds(),
    lesson: idleLesson,
    coach: () => coach,
    foregroundApp: async () => (await foregroundSkill(1500))?.id ?? null,
    lessonHint: (voice) => !!deps.runner()?.idle(voice),
    coachHint,
    log: deps.log,
    clock
  })

  function install(): void {
    const tick = (): void => {
      void checkReminder().finally(() => {
        reminderTimer = clock.setTimeout(tick, REMINDER_POLL_MS)
      })
    }
    reminderTimer = clock.setTimeout(tick, REMINDER_POLL_MS)
    deps.runner()?.onChange(() => watcher.sync())
    watcher.sync()
  }

  function stop(): void {
    if (reminderTimer) clock.clearTimeout(reminderTimer)
    reminderTimer = null
    watcher.stop()
  }

  return {
    startReview,
    intercept,
    onLessonDone,
    checkReminder,
    idleHintsFor,
    sync: () => watcher.sync(),
    watcher,
    coachMode: () => coach,
    suggestion: () => freshSuggestion(),
    install,
    stop
  }
}
