// Buddies as Home and Settings see them (08 T52 IPC, read by T53's UI). Pure types.
import type { Buddy, BuddySummary } from './buddies'

export type { BuddyRunSummary } from './buddies'

export interface BuddyRow extends BuddySummary {
  /** The next time one of its schedules runs. */
  nextRunAt?: number
  /** It works on screen right now (the foreground agent task). */
  onScreen: boolean
}

export interface BuddiesView {
  buddies: BuddyRow[]
  /** "pause all buddies": scheduled runs skip until resumed. */
  pausedAll: boolean
}

/** One of a buddy's schedules (an automation with action buddy). */
export interface BuddyScheduleView {
  automationId: string
  triggerText: string
  enabled: boolean
  nextRunAt?: number
  wake?: boolean
  /** Extra words for these runs. */
  prompt?: string
}

export interface BuddyDetail {
  buddy: Buddy
  schedules: BuddyScheduleView[]
  running: boolean
  onScreen: boolean
}

/** What Settings may change on a buddy (08 T53); main clamps it on save. */
export type BuddyEditable = Pick<
  Buddy,
  | 'name'
  | 'look'
  | 'instructions'
  | 'permissions'
  | 'model'
  | 'report'
  | 'budget'
  | 'skills'
  | 'subagents'
>

export type BuddyUpdateResult = { ok: true; buddy: Buddy } | { ok: false; error: string }

export type BuddyWhenResult = { ok: true; description: string } | { ok: false; error: string }

export interface BuddyRunResult {
  ok: boolean
  /** The background task (Tasks list, task chat). */
  taskId?: string
  /** It started as the foreground agent task. */
  onScreen?: boolean
  error?: string
}
