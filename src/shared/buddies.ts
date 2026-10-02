// Buddies (08 T50, plans buddies.md): named, persistent helpers with a job, their own
// permissions, model, budget and memory notebook. Each run is a background task with origin
// `buddy`. Pure types and constants, shared by main and the renderer.
import type { AutomationTrigger } from './automations'
import type { SkillPermissions } from './types'

export type BuddyReport = 'notify' | 'spoken' | 'silent' | 'cards'
export type BuddyTrigger = 'call' | 'schedule' | 'manual'
export type BuddyTrust = 'mine' | 'community-untrusted'
/** fast / main, or another model role ('planning'). */
export type BuddyModel = 'fast' | 'main' | 'planning'

export interface BuddyLook {
  /** "#rrggbb". */
  color: string
  /** One emoji, or else one letter (`initial`). */
  emoji?: string
  initial?: string
}

/**
 * Least privilege, the skill permission shape plus the buddy's tool list and apps:
 * `files.read` / `files.write` are its folders, `network` its https origins, `screen` whether it
 * may ask to work on screen, `profile` whether it may search the user's memory.
 */
export interface BuddyPermissions extends SkillPermissions {
  /** Background tools it may call (finish, ask_user, memory_write and notify always). */
  tools: string[]
  /** App ids its on-screen work is limited to (empty = any, only with input). */
  apps: string[]
}

export interface BuddyBudget {
  /** Cost cap of one run (the run pauses with "Keep going?" there). */
  perRunUsd: number
  perMonthUsd?: number
  perMonthTokens?: number
}

export interface Buddy {
  /** Folder name under ~/.ai-overlay/buddies: lowercase letters, digits and dashes. */
  id: string
  name: string
  look: BuddyLook
  /** What it is for, how it works, what it reports (buddy.md body). */
  instructions: string
  permissions: BuddyPermissions
  model: BuddyModel
  budget: BuddyBudget
  /** Skills it may load with use_skill. */
  skills: string[]
  /** May split work into helpers (run_subagents). */
  subagents: boolean
  report: BuddyReport
  /** Automations (automations.json, action `{kind:'buddy'}`) that start it. */
  scheduleIds: string[]
  trust: BuddyTrust
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** One buddy as lists show it. */
export interface BuddySummary {
  id: string
  name: string
  look: BuddyLook
  /** First line of the instructions, short. */
  description: string
  model: BuddyModel
  report: BuddyReport
  trust: BuddyTrust
  enabled: boolean
  scheduleIds: string[]
  /** A task of this buddy is queued or running. */
  running: boolean
  lastRun?: BuddyRunSummary
}

/** One run of a buddy, from the task store. */
export interface BuddyRunSummary {
  taskId: string
  title: string
  phase: string
  startedAt: number
  endedAt?: number
  summary?: string
  costUsd: number
}

export const BUDDY_NOTEBOOK_MAX_BYTES = 8 * 1024
export const BUDDY_INSTRUCTIONS_MAX = 8000
export const BUDDY_NAME_MAX = 40
export const BUDDY_DEFAULT_PER_RUN_USD = 0.25

// ---- making buddies (08 T51) ----

/** A schedule the draft proposes (not created: an automation with action buddy does that). */
export interface BuddySchedule {
  /** The "when" phrase ("every weekday at 8"). */
  text: string
  trigger: AutomationTrigger
  /** describeTrigger's words ("every weekday at 08:00"). */
  description: string
}

/** A buddy written from a description or changed by voice, waiting for review. */
export interface BuddyDraft {
  name: string
  look: BuddyLook
  /** One sentence: what it does. */
  description: string
  /** buddy.md body (its first line is the description). */
  instructions: string
  permissions: BuddyPermissions
  model: BuddyModel
  report: BuddyReport
  budget: BuddyBudget
  skills: string[]
  subagents: boolean
  schedule?: BuddySchedule
}

export type BuddyComposePreview =
  | {
      ok: true
      draft: BuddyDraft
      /** Plain words for what it may do ("It may read web pages on …"). */
      permissionsLine: string
      warnings: string[]
    }
  | { ok: false; error: string }

export type BuddyComposeSaveResult =
  | { ok: true; id: string; name: string; schedule?: BuddySchedule }
  | { ok: false; error: string }

/** What a `.lumen` buddy file holds, before install. */
export type BuddyImportPreview =
  | {
      ok: true
      token: string
      buddies: {
        /** The id it installs under (a free one when the user has a buddy of that name). */
        id: string
        name: string
        look: BuddyLook
        description: string
        permissions: BuddyPermissions
        permissionsLine: string
        model: BuddyModel
        budget: BuddyBudget
        /** What the import left out or lowered (folders, budget). */
        notes: string[]
        /** It replaces an earlier import of the same buddy. */
        updates: boolean
      }[]
    }
  | { ok: false; error: string; problems?: string[] }

export type BuddyImportResult =
  | { ok: true; installed: { id: string; name: string; updated: boolean }[] }
  | { ok: false; error: string; problems?: string[] }
