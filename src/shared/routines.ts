// Routines (08 T22) and proactive rules (08 T23): the older formats automations are imported
// from (automations.ts), and the pre-approved call shapes they share. Pure TS.

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

/** A user-defined proactive rule: when `app` comes to the front, say `say`. */
export interface ProactiveRule {
  id: string
  /** App name as said ("Resolve"); matched against the process and window title. */
  app: string
  say: string
}
