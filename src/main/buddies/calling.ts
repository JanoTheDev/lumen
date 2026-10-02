// Calling buddies (08 T52), wired to Lumen: the pipeline's buddy turn (T51's creation turn first,
// then the calling grammar), "run now" for voice and Settings (background, or the foreground
// agent task for a buddy that needs the screen while the user is present), stop, pause all,
// and scheduled runs through automations with action `{kind: 'buddy', buddyId}`.
import { join, dirname } from 'path'
import { powerMonitor } from 'electron'
import type { Automation } from '@shared/automations'
import type { Buddy, BuddyRunSummary } from '@shared/buddies'
import type { BackgroundTask, ModelResponse } from '@shared/types'
import { requireAgent } from '../agent/instance'
import { backgroundManager, notice, userBusy } from '../agent-mode/background'
import { isOpen } from '../agent-mode/background/manager'
import { PRESENT_MS } from '../agent-mode/background/presence'
import { skillEnvelope } from '../agent-mode/skill-envelope'
import {
  agentRunning,
  runAgentTask,
  runningAgentTaskId,
  stopAgentTask
} from '../agent-mode/session'
import { bus } from '../bus'
import { configPath, loadConfig } from '../config'
import { log } from '../logger'
import { windowOnlyContext } from '../query/context'
import {
  addAutomation,
  automations,
  automationsLoaded,
  onAutomationsChanged,
  setBuddyAutomationRunner,
  userPresent
} from '../routines'
import { allowsForeground } from '../routines/preapproval'
import { setBuddyNamer } from '../routines/triggers'
import type { RunEnd } from '../routines/engine'
import * as assistant from '../windows/assistant'
import { buddyCreationTurn, setBuddyScheduler } from './creation-voice'
import { chooseLane, runBuddyForeground } from './foreground'
import {
  buddyNotebook,
  buddyRuns,
  buddySummaries,
  getBuddy,
  ledgerSpend,
  listBuddies,
  runBuddy,
  setBuddyEnabled,
  updateBuddy,
  type RunBuddyOpts
} from './index'
import {
  BuddyPauseFlag,
  removeBuddySchedules,
  replaceBuddySchedule,
  runScheduledBuddy,
  setScheduleHost,
  syncScheduleIds
} from './schedule'
import { overBudget } from './service'
import { BuddyVoice } from './voice'

let pause: BuddyPauseFlag | null = null
/** The buddy running as the foreground agent task, if any. */
let onScreen: string | null = null

const pauseFlag = (): BuddyPauseFlag =>
  (pause ??= new BuddyPauseFlag(join(dirname(configPath()), 'buddies-state.json')))

export const buddiesPaused = (): boolean => pauseFlag().get()

/** The buddy working on screen right now (the foreground agent task), if any. */
export const buddyOnScreen = (): string | null => onScreen

export function setBuddiesPaused(paused: boolean): void {
  pauseFlag().set(paused)
  bus.emit({ type: 'buddies.changed', ids: listBuddies().map((b) => b.id) })
}

// ---- run now ----

export type CallOutcome =
  | { ok: true; lane: 'background'; task: BackgroundTask }
  | { ok: true; lane: 'foreground'; response: Promise<ModelResponse> }
  | { ok: false; code: 'E_NOT_FOUND' | 'E_OFF' | 'E_BUDGET'; error: string }

function foreground(b: Buddy, opts: RunBuddyOpts, signal: AbortSignal): Promise<ModelResponse> {
  onScreen = b.id
  return runBuddyForeground(b, opts, signal, {
    runTask: async (prompt, sig, o) => {
      const win = await requireAgent()
        .activeWindow()
        .catch(() => '')
      return runAgentTask(prompt, windowOnlyContext(win), sig, o)
    },
    envelope: skillEnvelope,
    notebook: buddyNotebook,
    working: (buddyId, active) => bus.emit({ type: 'buddy.working', buddyId, active })
  }).finally(() => {
    if (onScreen === b.id) onScreen = null
  })
}

/**
 * Runs the buddy now. On screen when it needs the screen, the user is present (a call or a
 * click counts; a schedule also needs its pre-approval) and no foreground task runs.
 */
export function startBuddyNow(
  id: string,
  opts: RunBuddyOpts,
  ctx: { signal?: AbortSignal; present?: boolean; preApproved?: boolean } = {}
): CallOutcome {
  const b = getBuddy(id)
  if (!b) return { ok: false, code: 'E_NOT_FOUND', error: 'There is no such buddy.' }
  const lane = chooseLane(b, {
    trigger: opts.trigger,
    present: ctx.present ?? true,
    agentBusy: agentRunning(),
    ...(ctx.preApproved !== undefined ? { preApproved: ctx.preApproved } : {})
  })
  if (lane === 'foreground') {
    if (!b.enabled) return { ok: false, code: 'E_OFF', error: `${b.name} is turned off.` }
    const over = overBudget(b, ledgerSpend(b.id, new Date()))
    if (over) return { ok: false, code: 'E_BUDGET', error: over }
    log('plan', `buddy ${b.id} runs on screen (${opts.trigger})`)
    return {
      ok: true,
      lane,
      response: foreground(b, opts, ctx.signal ?? new AbortController().signal)
    }
  }
  const r = runBuddy(id, opts)
  return r.ok ? { ok: true, lane: 'background', task: r.task } : r
}

/** Cancels the buddy's running tasks (and its foreground task); how many. */
export function stopBuddy(id: string): number {
  const m = backgroundManager()
  let n = 0
  for (const t of m.list()) if (t.buddyId === id && !t.parentId && isOpen(t) && m.cancel(t.id)) n++
  if (onScreen === id) {
    const task = runningAgentTaskId()
    if (task && stopAgentTask(task)) n++
  }
  return n
}

export function stopAllBuddies(): number {
  return listBuddies().reduce((n, b) => n + stopBuddy(b.id), 0)
}

/** The next time one of the buddy's schedules runs. */
export function buddyNextRun(id: string): number | undefined {
  if (!automationsLoaded()) return undefined
  let next: number | undefined
  for (const a of automations().list())
    if (a.action.kind === 'buddy' && a.action.buddyId === id && a.nextRunAt !== undefined)
      next = next === undefined ? a.nextRunAt : Math.min(next, a.nextRunAt)
  return next
}

// ---- voice ----

const say = (text: string): ModelResponse => ({ mode: 'answer', text, spoken: text })

let turnSignal: AbortSignal | undefined

async function callReply(b: Buddy, utterance: string): Promise<ModelResponse> {
  const out = startBuddyNow(
    b.id,
    { trigger: 'call', ...(utterance ? { utterance } : {}) },
    turnSignal ? { signal: turnSignal } : {}
  )
  if (!out.ok)
    return say(out.code === 'E_OFF' ? `${out.error} Say “turn on ${b.name}” first.` : out.error)
  if (out.lane === 'foreground') return out.response
  const t = out.task
  return say(
    t.phase === 'queued'
      ? `${b.name} will start when another task finishes.`
      : b.report === 'silent'
        ? `${b.name} is on it. The result goes to the Tasks list.`
        : `${b.name} is on it. I’ll tell you when it’s done.`
  )
}

const lastRun = (id: string): BuddyRunSummary | undefined => buddyRuns(id, 1)[0]

const voice = new BuddyVoice({
  list: listBuddies,
  summaries: buddySummaries,
  call: callReply,
  stop: stopBuddy,
  stopAll: stopAllBuddies,
  setEnabled: (id, on) => !!setBuddyEnabled(id, on),
  pausedAll: buddiesPaused,
  setPausedAll: setBuddiesPaused,
  nextRunAt: buddyNextRun,
  lastRun,
  now: () => Date.now()
})

const canSpeakUp = (): boolean =>
  !loadConfig().agent.background.quiet && powerMonitor.getSystemIdleTime() * 1000 < PRESENT_MS

/**
 * The pipeline's buddy turn: making / editing a buddy (T51) first, then calling one. Null when
 * the words are about no buddy.
 */
export async function buddyTurn(text: string, signal: AbortSignal): Promise<ModelResponse | null> {
  const said: string[] = []
  const made = await buddyCreationTurn(text, {
    say: (t) => said.push(t),
    showCard: (summary, risk) => assistant.requestConfirm({ summary, risk }),
    notice,
    canSpeakUp,
    log: (msg) => log('plan', msg)
  })
  if (made) return say(said.join(' ').trim() || 'Okay.')
  turnSignal = signal
  try {
    return await voice.turn(text)
  } finally {
    turnSignal = undefined
  }
}

// ---- schedules ----

function scheduledOnScreen(b: Buddy, a: Automation, opts: RunBuddyOpts): Promise<RunEnd> | null {
  const out = startBuddyNow(b.id, opts, {
    present: userPresent() && !userBusy(),
    preApproved: allowsForeground(a.preApproved)
  })
  if (!out.ok || out.lane !== 'foreground') {
    // It started in the background after all (the screen got busy): wait for that task.
    if (out.ok && out.lane === 'background')
      return backgroundManager()
        .wait(out.task.id)
        .then((end) => ({
          result: end.phase === 'done' ? 'done' : end.phase === 'failed' ? 'failed' : 'cancelled',
          ...(end.result?.summary ? { summary: end.result.summary } : {}),
          taskId: out.task.id
        }))
    return null
  }
  return out.response.then(
    (r): RunEnd => {
      const v = r as { spoken?: string; text?: string }
      const text = v.spoken || v.text || ''
      if (text) notice(`${b.name}: ${text}`)
      return { result: 'done', ...(text ? { summary: text } : {}) }
    },
    (e: Error): RunEnd => ({
      result: e.name === 'AbortError' ? 'cancelled' : 'failed',
      summary: e.message
    })
  )
}

let installed = false

/** Wires schedules, the automation runner and buddy names into automations. */
export function installBuddyCalling(): void {
  if (installed) return
  installed = true
  setScheduleHost({
    automations: () => (automationsLoaded() ? automations().all() : null),
    add: (input) => addAutomation(input),
    remove: (id) => automations().remove(id),
    buddies: listBuddies,
    getBuddy,
    setScheduleIds: (id, scheduleIds) => void updateBuddy(id, { scheduleIds })
  })
  setBuddyNamer((id) => getBuddy(id)?.name ?? null)
  // Buddy creation (T51): a new or changed schedule replaces the buddy's earlier ones.
  setBuddyScheduler((b, schedule) => replaceBuddySchedule(b.id, schedule))
  setBuddyAutomationRunner((a, ctx) =>
    runScheduledBuddy(a, ctx, {
      pausedAll: buddiesPaused,
      getBuddy,
      run: runBuddy,
      wait: (id) => backgroundManager().wait(id),
      foreground: (b, auto, opts) =>
        chooseLane(b, {
          trigger: 'schedule',
          present: userPresent() && !userBusy(),
          agentBusy: agentRunning(),
          preApproved: allowsForeground(auto.preApproved)
        }) === 'foreground'
          ? scheduledOnScreen(b, auto, opts)
          : null,
      notice,
      now: () => Date.now()
    })
  )
  onAutomationsChanged(syncScheduleIds)
  syncScheduleIds()
  // A deleted buddy takes its schedules with it.
  bus.on('buddies.changed', (e) => {
    for (const id of e.ids) if (!getBuddy(id)) removeBuddySchedules(id)
  })
}
