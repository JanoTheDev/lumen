// Routines (08 T22) and proactive rules (08 T23): wiring. A routine run is a background task
// with origin "routine" (agent-mode/background); its high-risk tool calls need the routine's
// pre-approval. Everything stays on this PC (~/.ai-overlay/routines.json, config
// agent.proactive); the scheduler and the proactive watcher run only while Lumen is open.
import { ipcMain } from 'electron'
import { randomBytes } from 'crypto'
import { dirname, join } from 'path'
import { z } from 'zod'
import type { ProactiveRule, Routine, RoutineView } from '@shared/routines'
import type { ConfigV2 } from '@shared/config'
import { getAgent } from '../agent/instance'
import { wantFocusEvents } from '../a11y/focus-events'
import { foregroundWindow } from '../actions/policy'
import {
  backgroundManager,
  notice,
  setRoutineShapes,
  startBackgroundTask,
  userBusy
} from '../agent-mode/background'
import { taskTitle } from '../agent-mode/background/manager'
import { configPath, loadConfig } from '../config'
import { INVALID, safeParse } from '../ipc/validate'
import { onConfigPatched, patchConfig } from '../ipc/settings'
import { log } from '../logger'
import * as assistant from '../windows/assistant'
import { FOREGROUND_SHAPE } from './preapproval'
import { MAX_RULES, parseProactiveRule, ProactiveWatcher } from './proactive'
import { RoutineScheduler, type RunResult } from './scheduler'
import { describeSchedule, parseRoutineUtterance } from './schedule'
import { ROUTINE_ID_RE, RoutineStore } from './store'

const STARTED_NOTICE_MS = 4000

const newRoutineId = (): string => `rt_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
const newRuleId = (): string => `pr_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

let store: RoutineStore | null = null
let lastCreated: string | null = null

function runRoutine(r: Routine): Promise<RunResult> {
  const t = startBackgroundTask({
    prompt: r.prompt,
    title: r.name,
    origin: 'routine',
    routineId: r.id
  })
  log('plan', `routine ${r.id} started task ${t.id}`)
  // The cancel window: a short notice on the bar (never over the user's own turn).
  if (!userBusy() && !loadConfig().agent.background.quiet)
    assistant.setStatus(
      'idle',
      `Routine “${r.name}” is running in the background. Cancel it in the Tasks list.`,
      undefined,
      STARTED_NOTICE_MS
    )
  return backgroundManager()
    .wait(t.id)
    .then((end) =>
      end.phase === 'done' ? 'done' : end.phase === 'failed' ? 'failed' : 'cancelled'
    )
}

const scheduler = new RoutineScheduler({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  run: runRoutine,
  save: (list) => store?.save(list),
  disabled: (r) => {
    log('fail', `routine ${r.id} turned off after repeated failures`)
    notice(`Routine “${r.name}” failed three times in a row, so I turned it off.`)
  },
  newId: newRoutineId
})

export function routines(): RoutineScheduler {
  return scheduler
}

// ---- proactive ----

function proactiveCfg(): ConfigV2['agent']['proactive'] {
  return loadConfig().agent.proactive
}

const watcher = new ProactiveWatcher({
  enabled: () => proactiveCfg().enabled,
  rules: () => proactiveCfg().rules,
  subscribe: (on) => wantFocusEvents('proactive', on),
  foreground: () => foregroundWindow(),
  say: (text) => notice(text),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout)
})

function addRule(rule: Omit<ProactiveRule, 'id'>): ProactiveRule | null {
  const p = proactiveCfg()
  if (p.rules.length >= MAX_RULES) return null
  const r: ProactiveRule = { id: newRuleId(), ...rule }
  // Through the settings path: saved, Settings refreshes, the watcher re-syncs.
  void patchConfig({ agent: { proactive: { ...p, rules: [...p.rules, r] } } })
  return r
}

// ---- voice ----

const answer = (text: string): { mode: 'answer'; text: string; spoken: string } => ({
  mode: 'answer',
  text,
  spoken: text
})

const words = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const REMOVE_LAST_RE =
  /^(?:delete|remove|cancel|undo|stop) (?:that|the last|this) (?:new )?routine$/
const LIST_RE =
  /^(?:what|which) routines (?:do i have|are there|are set up)$|^list (?:my )?routines$/

/** Whole-utterance routine and proactive-rule commands; undefined = not ours. */
export function interceptRoutines(prompt: string): unknown | undefined {
  const w = words(prompt)
  if (REMOVE_LAST_RE.test(w)) {
    const r = lastCreated ? scheduler.get(lastCreated) : null
    if (!r) return answer('There is no new routine to remove.')
    scheduler.remove(r.id)
    lastCreated = null
    return answer(`Removed the routine “${r.name}”.`)
  }
  if (LIST_RE.test(w)) {
    const list = scheduler.list()
    if (!list.length) return answer('You have no routines yet.')
    return answer(
      list.map((r) => `- ${r.name}: ${r.scheduleText}${r.enabled ? '' : ' (off)'}`).join('\n')
    )
  }
  const rule = parseProactiveRule(prompt)
  if (rule) {
    const saved = addRule(rule)
    if (!saved) return answer(`You already have ${MAX_RULES} reminders; remove one in Settings.`)
    const off = proactiveCfg().enabled
      ? ''
      : ' Proactive mode is off, so turn it on in Settings, Background and routines, for it to work.'
    return answer(`Okay. When you open ${saved.app}, I’ll say: “${saved.say}”${off}`)
  }
  const parsed = parseRoutineUtterance(prompt)
  if (!parsed) return undefined
  if (!parsed.ok) return answer(parsed.reason)
  const r = scheduler.add({
    name: taskTitle(parsed.prompt),
    prompt: parsed.prompt,
    schedule: parsed.schedule
  })
  if (!r) return answer('You have too many routines; remove one in Settings first.')
  lastCreated = r.id
  const when = describeSchedule(r.schedule)
  return answer(
    `Okay, ${when} I’ll run “${r.prompt}” in the background while Lumen is open. Say “delete that routine” to undo it.`
  )
}

// ---- IPC ----

const routineIdSchema = z.string().regex(ROUTINE_ID_RE)
const updateSchema = z
  .object({
    id: routineIdSchema,
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    allowForeground: z.boolean().optional()
  })
  .strict()

export function registerRoutinesIpc(): void {
  ipcMain.handle('routines:list', (_e, ...args: unknown[]): RoutineView[] | typeof INVALID =>
    args.length ? INVALID : scheduler.list()
  )
  ipcMain.handle('routines:update', (_e, raw: unknown) => {
    const u = safeParse('routines:update', updateSchema, raw)
    if (!u) return INVALID
    const r = scheduler.get(u.id)
    if (!r) return { ok: false }
    const others = r.preApproved.filter((s) => !(s.tool === FOREGROUND_SHAPE.tool && !s.args))
    return {
      ok: scheduler.update(u.id, {
        ...(u.enabled !== undefined ? { enabled: u.enabled } : {}),
        ...(u.name !== undefined ? { name: u.name } : {}),
        ...(u.allowForeground !== undefined
          ? { preApproved: u.allowForeground ? [...others, FOREGROUND_SHAPE] : others }
          : {})
      })
    }
  })
  ipcMain.handle('routines:remove', (_e, raw: unknown) => {
    const id = safeParse('routines:remove', routineIdSchema, raw)
    if (id === undefined) return INVALID
    return { ok: scheduler.remove(id) }
  })
  ipcMain.handle('routines:run-now', (_e, raw: unknown) => {
    const id = safeParse('routines:run-now', routineIdSchema, raw)
    if (id === undefined) return INVALID
    return { ok: scheduler.runNow(id) }
  })
}

// ---- install ----

let installed = false

export function installRoutines(file = join(dirname(configPath()), 'routines.json')): void {
  if (installed) return
  installed = true
  store = new RoutineStore(file)
  setRoutineShapes((id) => scheduler.get(id)?.preApproved ?? null)
  scheduler.start(store.load())
  watcher.sync()
  onConfigPatched(() => watcher.sync())
  getAgent()?.onEvent('focus-changed', () => watcher.onFocusChanged())
}
