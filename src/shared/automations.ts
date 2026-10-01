// Automations: a trigger (a time, Lumen starting, an app opening or closing, a file in a granted
// folder, the PC going idle or coming back, the network coming back) and an action (a background
// task, a skill, or a spoken reminder). They grew out of routines (08 T22) and proactive rules
// (08 T23). Pure TS (Settings imports it through channels.ts).
import type { ActionShape } from './routines'

/** Weekdays: 0 = Sunday … 6 = Saturday; empty / missing = every day. */
export type TimeTrigger =
  | { kind: 'daily'; at: string; days?: number[] }
  /**
   * Every N minutes (N ≥ 15). With `from` / `to` ("HH:MM") it runs at from, from + N, … up to
   * `to` on the listed days; without them it counts from the last run.
   */
  | { kind: 'every'; minutes: number; from?: string; to?: string; days?: number[] }
  /** Day 1-31 of every month at HH:MM; a day past the month's end runs on its last day. */
  | { kind: 'monthly'; day: number; at: string }
  /** Once, at this time (ms epoch); it turns itself off after that. */
  | { kind: 'once'; at: number }

export type EventTrigger =
  /** Lumen starts (at sign-in when start at login is on). */
  | { kind: 'startup' }
  /** The app comes to the front (open) or is no longer running (close). */
  | { kind: 'app'; app: string; on: 'open' | 'close' }
  /** A file appears in / changes in a folder background tasks may read; `pattern` like "*.pdf". */
  | { kind: 'file'; folder: string; on: 'added' | 'changed'; pattern?: string }
  /** No input for N minutes (idle), or input again after N idle minutes (back). */
  | { kind: 'idle'; minutes: number; on: 'idle' | 'back' }
  /** The network comes back after being offline. */
  | { kind: 'online' }

export type AutomationTrigger = TimeTrigger | EventTrigger

export type AutomationAction =
  /** A background task with this prompt (the user's words). */
  | { kind: 'task'; prompt: string }
  /** A skill run as a background task; `prompt` adds detail. */
  | { kind: 'skill'; skill: string; prompt?: string }
  /** Says this (presence rule); when nobody is around it waits in the Tasks list. */
  | { kind: 'remind'; say: string }

export type AutomationResult = 'done' | 'failed' | 'cancelled'

export interface AutomationRun {
  at: number
  result: AutomationResult | 'skipped'
  via: 'time' | 'event' | 'manual' | 'wake' | 'catch-up'
  /** First line of the task's result, or why it was skipped. */
  summary?: string
  taskId?: string
}

export interface Automation {
  id: string
  name: string
  trigger: AutomationTrigger
  action: AutomationAction
  preApproved: ActionShape[]
  enabled: boolean
  /** Consecutive failed runs; 3 turn the automation off. */
  failures: number
  createdAt: number
  /** Wake Lumen for this (a Windows Task Scheduler entry; time triggers, installed build). */
  wake?: boolean
  /** A time run missed while Lumen was closed runs once when Lumen starts. */
  catchUp?: boolean
  lastRunAt?: number
  lastResult?: AutomationResult
  /** Why it was turned off by itself. */
  disabledReason?: string
  /** Newest last, at most 10. */
  runs?: AutomationRun[]
}

export interface AutomationView extends Automation {
  triggerText: string
  actionText: string
  nextRunAt?: number
  running: boolean
  /** The trigger cannot fire right now (folder not shared, …). */
  problem?: string
}

export interface AutomationUpdate {
  id: string
  enabled?: boolean
  name?: string
  /** A new trigger in words ("every weekday at 9", "when I open Excel"). */
  trigger?: string
  /** The task's prompt (task and skill actions) or the reminder text. */
  text?: string
  /** May use the mouse and keyboard (request_foreground), only while the user is at the PC. */
  allowForeground?: boolean
  /** May use connector tools (mcp__*) without asking. */
  allowConnectors?: boolean
  wake?: boolean
  catchUp?: boolean
}

/** A parsed request before the user said yes. */
export interface AutomationDraft {
  name: string
  trigger: AutomationTrigger
  action: AutomationAction
  /** Plain-language summary for the confirm card. */
  summary: string
  /** Risky things it may need; each is a pre-approval choice. */
  wants: { foreground: boolean; connectors: boolean }
  /** A folder that gets shared with background tasks when it is saved. */
  shareFolder?: string
}

export interface AutomationsInfo {
  /** "Wake Lumen for this" works in this build (installed, not dev or portable). */
  wakeSupported: boolean
  skills: { name: string; description: string }[]
}
