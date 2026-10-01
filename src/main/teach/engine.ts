// Lesson state machine (plans 07 T13, lesson-engine.md): a pure reducer
// (state, event) → { state, effects }. No Electron, no timers, no I/O: runner.ts executes
// the effects and feeds timer, check and do-it results back in as events.
import {
  LEVEL,
  OFFER_ACTION_ID,
  PRAISE,
  fasterPace,
  hintText,
  nextHintDelay,
  slowerPace,
  startLevel,
  stepState
} from './hints'
import type { LessonStep } from './lesson'
import {
  IDLE,
  isRunning,
  type LessonCommand,
  type LessonEffect,
  type LessonEvent,
  type LessonState,
  type StepStats,
  type Transition
} from './state'

/** The success tick stays this long before the next step. */
export const ADVANCE_MS = 600

const OFFER_TEXT = 'Want me to do this step for you? Say yes, or keep trying.'
const NOT_YET = 'Not quite yet.'

const emptyStats = (): StepStats => ({ attempts: 0, hints: 0, skipped: false, doItForMe: false })

function stepOf(s: LessonState): LessonStep {
  return s.lesson!.steps[s.index]
}

function withStats(s: LessonState, patch: Partial<StepStats>): LessonState {
  const id = stepOf(s).id
  return { ...s, stats: { ...s.stats, [id]: { ...(s.stats[id] ?? emptyStats()), ...patch } } }
}

const stats = (s: LessonState): StepStats => s.stats[stepOf(s).id] ?? emptyStats()

const cancelAll: LessonEffect[] = [
  { type: 'cancelChecks' },
  { type: 'cancelTimer', id: 'hint' },
  { type: 'cancelTimer', id: 'timeout' },
  { type: 'cancelTimer', id: 'advance' }
]

function hintTimer(level: number, pace: number): LessonEffect[] {
  const ms = nextHintDelay(level, pace)
  return ms === null ? [] : [{ type: 'startTimer', id: 'hint', ms }]
}

function present(s0: LessonState, index: number): Transition {
  const lesson = s0.lesson!
  const step = lesson.steps[index]
  const level = startLevel(step)
  let s: LessonState = { ...s0, phase: 'step.waiting', index, level }
  if (!s.stats[step.id]) s = withStats(s, {})
  const effects: LessonEffect[] = [
    ...cancelAll,
    { type: 'assistant', state: stepState(lesson, index, step.say) },
    { type: 'point', step: index, level },
    { type: 'say', text: step.say, interruptible: true },
    { type: 'startChecks', step: index },
    ...hintTimer(level, s.pace),
    ...(step.timeoutSec
      ? [
          {
            type: 'startTimer',
            id: 'timeout',
            ms: Math.round(step.timeoutSec * 1000 * s.pace)
          } as const
        ]
      : []),
    { type: 'event', name: 'step-started', step: index },
    { type: 'persist' }
  ]
  return { state: s, effects }
}

/** Moves the hint ladder to `level` (never down). L4 and up is the do-it offer. */
function escalate(s0: LessonState, target: number): Transition {
  const lesson = s0.lesson!
  const step = stepOf(s0)
  const level = Math.max(s0.level, target)
  if (level >= LEVEL.OFFER) return offer({ ...s0, level: LEVEL.OFFER })
  let s: LessonState = { ...s0, level }
  const text = hintText(step, level)
  if (level >= LEVEL.HINT) s = withStats(s, { hints: Math.max(stats(s).hints, level - 1) })
  const effects: LessonEffect[] = [
    { type: 'cancelTimer', id: 'hint' },
    { type: 'point', step: s.index, level }
  ]
  if (text) {
    effects.push(
      { type: 'say', text, interruptible: true },
      { type: 'assistant', state: stepState(lesson, s.index, text) }
    )
  }
  effects.push(...hintTimer(level, s.pace), { type: 'log', msg: `hint level ${level}` })
  return { state: s, effects }
}

function offer(s0: LessonState): Transition {
  const s: LessonState = withStats({ ...s0, phase: 'offer-do-it' }, { hints: 3 })
  return {
    state: s,
    effects: [
      { type: 'cancelTimer', id: 'hint' },
      { type: 'cancelTimer', id: 'timeout' },
      { type: 'point', step: s.index, level: LEVEL.RING },
      { type: 'say', text: OFFER_TEXT, interruptible: true },
      {
        type: 'assistant',
        state: stepState(s.lesson!, s.index, OFFER_TEXT, {
          phase: 'confirm',
          confirm: { actionId: OFFER_ACTION_ID, summary: 'Do this step for me', risk: 'low' }
        })
      },
      { type: 'log', msg: 'offer do it' }
    ]
  }
}

function doIt(s0: LessonState): Transition {
  const s: LessonState = withStats(
    { ...s0, phase: 'doing-it', level: LEVEL.DO },
    { doItForMe: true }
  )
  return {
    state: s,
    effects: [
      { type: 'cancelTimer', id: 'hint' },
      { type: 'cancelTimer', id: 'timeout' },
      {
        type: 'assistant',
        state: stepState(s.lesson!, s.index, 'Doing this step for you', { phase: 'acting' })
      },
      { type: 'exec', step: s.index }
    ]
  }
}

function passed(s0: LessonState, extraSay?: string): Transition {
  const s: LessonState = { ...s0, phase: 'step.passed', praise: s0.praise + 1 }
  const text = extraSay ?? PRAISE[s0.praise % PRAISE.length]
  return {
    state: s,
    effects: [
      ...cancelAll,
      { type: 'scene', scene: 'success' },
      { type: 'say', text, interruptible: true },
      { type: 'event', name: 'step-completed', step: s.index },
      { type: 'startTimer', id: 'advance', ms: ADVANCE_MS },
      { type: 'persist' }
    ]
  }
}

function nextOrFinish(s: LessonState): Transition {
  return s.index + 1 < s.lesson!.steps.length ? present(s, s.index + 1) : finish(s)
}

function finish(s0: LessonState): Transition {
  const lesson = s0.lesson!
  const s: LessonState = { ...s0, phase: 'done' }
  const n = lesson.steps.length
  const text = `That's the end of ${lesson.title}. You did all ${n} steps.`
  return {
    state: s,
    effects: [
      ...cancelAll,
      { type: 'scene', scene: 'clear' },
      { type: 'say', text, interruptible: false },
      { type: 'assistant', state: { phase: 'idle', statusText: 'Lesson complete' } },
      { type: 'event', name: 'done', step: s.index, completed: true },
      { type: 'persist' }
    ]
  }
}

function pause(s0: LessonState, why: string): Transition {
  const s: LessonState = { ...s0, phase: 'paused' }
  const text = 'Lesson paused. Say resume when you are ready.'
  return {
    state: s,
    effects: [
      ...cancelAll,
      { type: 'scene', scene: 'clear' },
      { type: 'say', text, interruptible: true },
      { type: 'assistant', state: stepState(s.lesson!, s.index, text) },
      { type: 'persist' },
      { type: 'log', msg: `paused (${why})` }
    ]
  }
}

function abort(s0: LessonState): Transition {
  const s: LessonState = { ...s0, phase: 'aborted' }
  return {
    state: s,
    effects: [
      ...cancelAll,
      { type: 'scene', scene: 'clear' },
      { type: 'say', text: 'Lesson stopped. You can resume it later.', interruptible: false },
      { type: 'assistant', state: null },
      { type: 'event', name: 'done', step: s.index, completed: false },
      { type: 'persist' }
    ]
  }
}

function notYet(s0: LessonState): Transition {
  let s: LessonState = withStats(
    { ...s0, phase: 'step.waiting' },
    { attempts: stats(s0).attempts + 1 }
  )
  const step = stepOf(s)
  const level = Math.min(LEVEL.RING, Math.max(s.level + 1, LEVEL.HINT))
  s = withStats({ ...s, level }, { hints: Math.max(stats(s).hints, level - 1) })
  const hint = hintText(step, level)
  const text = hint ? `${NOT_YET} ${hint}` : `${NOT_YET} ${step.say}`
  return {
    state: s,
    effects: [
      { type: 'point', step: s.index, level },
      { type: 'say', text, interruptible: true },
      { type: 'assistant', state: stepState(s.lesson!, s.index, text) },
      { type: 'startChecks', step: s.index },
      ...hintTimer(level, s.pace)
    ]
  }
}

const same = (s: LessonState): Transition => ({ state: s, effects: [] })

function intro(s0: LessonState): Transition {
  const lesson = s0.lesson!
  const text = `${lesson.title}. About ${lesson.minutes} minute${lesson.minutes === 1 ? '' : 's'}. Say next to begin.`
  return {
    state: { ...s0, phase: 'intro' },
    effects: [
      { type: 'say', text, interruptible: true },
      { type: 'assistant', state: { phase: 'waiting-user', statusText: text } },
      { type: 'persist' }
    ]
  }
}

/** Whether `command` does something in this state (else the utterance goes to the assistant). */
export function accepts(s: LessonState, command: LessonCommand): boolean {
  if (!isRunning(s)) return false
  switch (s.phase) {
    case 'intro':
      return ['next', 'done', 'yes', 'resume', 'stop', 'repeat', 'pause'].includes(command)
    case 'paused':
      return ['resume', 'next', 'stop', 'repeat', 'why'].includes(command)
    case 'offer-do-it':
    case 'ask-worked':
      return command !== 'resume'
    case 'doing-it':
      return command === 'stop' || command === 'pause'
    case 'step.passed':
      return ['next', 'done', 'skip', 'back', 'stop', 'pause'].includes(command)
    default:
      return command !== 'yes' && command !== 'no' && command !== 'resume'
  }
}

function onCommand(s: LessonState, c: LessonCommand): Transition {
  if (!accepts(s, c)) return same(s)
  if (c === 'stop') return abort(s)

  if (s.phase === 'intro') {
    if (c === 'repeat') return intro(s)
    if (c === 'pause') return pause(s, 'user')
    return present(s, s.index)
  }
  if (s.phase === 'paused') {
    if (c === 'repeat' || c === 'why') return pause(s, 'repeat')
    return present(s, s.index)
  }
  if (s.phase === 'doing-it') return pause(s, 'user')
  if (s.phase === 'step.passed' && c !== 'back' && c !== 'pause') return nextOrFinish(s)

  const step = stepOf(s)
  if (s.phase === 'ask-worked') {
    if (c === 'yes' || c === 'done') return passed(s)
    if (c === 'no') return notYet(s)
  }
  if (s.phase === 'offer-do-it') {
    if (c === 'yes' || c === 'do-it') return doIt(s)
    if (c === 'no') {
      const text = 'Okay. Keep going, I am watching.'
      return {
        state: { ...s, phase: 'step.waiting' },
        effects: [
          { type: 'say', text, interruptible: true },
          { type: 'assistant', state: stepState(s.lesson!, s.index, step.say) }
        ]
      }
    }
    if (c === 'help') return offer(s)
  }

  switch (c) {
    case 'next':
    case 'done':
      return {
        state: { ...s, phase: 'step.checking' },
        effects: [
          { type: 'cancelTimer', id: 'hint' },
          { type: 'assistant', state: stepState(s.lesson!, s.index, 'Checking') },
          { type: 'evaluate', step: s.index }
        ]
      }
    case 'back':
      return present(s, Math.max(0, s.index - 1))
    case 'skip': {
      const t = withStats(s, { skipped: true })
      return nextOrFinish({ ...t, phase: 'step.waiting' })
    }
    case 'repeat':
      return {
        state: s,
        effects: [
          { type: 'point', step: s.index, level: s.level },
          { type: 'say', text: step.say, interruptible: true },
          { type: 'assistant', state: stepState(s.lesson!, s.index, step.say) }
        ]
      }
    case 'why':
      return {
        state: s,
        effects: [
          {
            type: 'say',
            text: step.why ?? `This step is part of ${s.lesson!.title}.`,
            interruptible: true
          }
        ]
      }
    case 'pause':
      return pause(s, 'user')
    case 'help':
      return escalate(s, Math.max(s.level, LEVEL.POINT) + 1)
    case 'do-it':
      return doIt(s)
    case 'slower':
    case 'faster': {
      const pace = c === 'slower' ? slowerPace(s.pace) : fasterPace(s.pace)
      const text =
        c === 'slower' ? 'Okay, I will wait longer before hints.' : 'Okay, hints will come sooner.'
      return {
        state: { ...s, pace },
        effects: [
          { type: 'say', text, interruptible: true },
          { type: 'cancelTimer', id: 'hint' },
          ...(s.phase === 'step.waiting' ? hintTimer(s.level, pace) : [])
        ]
      }
    }
    default:
      return same(s)
  }
}

export function reduce(s: LessonState, e: LessonEvent): Transition {
  if (e.type === 'start') {
    const base: LessonState = {
      ...IDLE,
      lesson: e.lesson,
      skillId: e.skillId ?? null,
      source: e.source ?? 'pack',
      pace: e.pace ?? 1,
      stats: e.stats ?? {},
      index: Math.min(Math.max(0, e.stepIndex ?? 0), e.lesson.steps.length - 1)
    }
    const prev: LessonEffect[] = isRunning(s) ? cancelAll : []
    const t = e.stepIndex !== undefined || e.autoStart ? present(base, base.index) : intro(base)
    return { state: t.state, effects: [...prev, ...t.effects] }
  }
  if (!isRunning(s)) return same(s)

  switch (e.type) {
    case 'command':
      return onCommand(s, e.command)
    case 'timer':
      if (e.id === 'advance') return s.phase === 'step.passed' ? nextOrFinish(s) : same(s)
      if (s.phase !== 'step.waiting') return same(s)
      if (e.id === 'timeout') return escalate(s, LEVEL.OFFER)
      return escalate(s, Math.max(s.level, LEVEL.POINT) + 1)
    case 'check':
      if (e.step !== s.index) return same(s)
      if (e.result === 'pass') {
        return ['step.waiting', 'step.checking', 'offer-do-it', 'ask-worked'].includes(s.phase)
          ? passed(s)
          : same(s)
      }
      if (s.phase !== 'step.checking' || !e.forced) return same(s)
      if (e.result === 'fail') return notYet(s)
      return {
        state: { ...s, phase: 'ask-worked' },
        effects: [
          { type: 'say', text: 'Did it work? Say yes or no.', interruptible: true },
          { type: 'assistant', state: stepState(s.lesson!, s.index, 'Did it work? Say yes or no.') }
        ]
      }
    case 'do-it-done':
      if (e.step !== s.index || s.phase !== 'doing-it') return same(s)
      if (e.ok) return passed(s, e.said)
      return {
        state: { ...s, phase: 'step.waiting', level: LEVEL.OFFER },
        effects: [
          {
            type: 'say',
            text: `I couldn't do that one. ${stepOf(s).hints[0] ?? stepOf(s).say}`,
            interruptible: true
          },
          { type: 'assistant', state: stepState(s.lesson!, s.index, stepOf(s).say) },
          { type: 'startChecks', step: s.index }
        ]
      }
    case 'app-blur':
      return s.phase === 'step.waiting' || s.phase === 'offer-do-it'
        ? pause(s, 'app blur')
        : same(s)
  }
}
