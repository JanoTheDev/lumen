// Routines (08 T22): prompts Lumen runs on a schedule as background tasks, only while it is
// open. Pure TS (Settings imports it through channels.ts).

/** daily at HH:MM (optionally only on some weekdays), or every N minutes (N ≥ 15). */
export type RoutineSchedule =
  | {
      kind: 'daily'
      /** "HH:MM", 24 h, local time. */
      at: string
      /** 0 = Sunday … 6 = Saturday; empty / missing = every day. */
      days?: number[]
    }
  | { kind: 'every'; minutes: number }

/**
 * A pre-approved high-risk tool call shape: `tool` is a background tool name
 * (`request_foreground`, `mcp__<server>__<tool>`, a trailing `*` matches a prefix) and `args`
 * the argument values it must have (`*` is a wildcard, case-insensitive).
 */
export interface ActionShape {
  tool: string
  args?: Record<string, string>
}

export interface Routine {
  id: string
  name: string
  prompt: string
  schedule: RoutineSchedule
  preApproved: ActionShape[]
  enabled: boolean
  /** Consecutive failed runs; 3 turn the routine off. */
  failures: number
  createdAt: number
  lastRunAt?: number
  lastResult?: 'done' | 'failed' | 'cancelled'
  /** Why it was turned off by itself (3 failures). */
  disabledReason?: string
}

/** What Settings shows: the routine plus its next run (ms epoch, none when off). */
export interface RoutineView extends Routine {
  nextRunAt?: number
  scheduleText: string
}

export interface RoutineUpdate {
  id: string
  enabled?: boolean
  name?: string
  /** Lets the routine use the mouse (request_foreground) without asking first. */
  allowForeground?: boolean
}

/** A user-defined proactive rule: when `app` comes to the front, say `say`. */
export interface ProactiveRule {
  id: string
  /** App name as said ("Resolve"); matched against the process and window title. */
  app: string
  say: string
}
