// Automation (routine) pre-approval (safety-policy §5): an automation runs while nobody may be
// watching, so its high-risk tool calls are skipped unless it pre-approved that exact call shape
// when it was set up, and it never takes the mouse and keyboard while the user is away. Low and
// medium calls run as in any background task.
import type { ActionShape } from '@shared/routines'

export type RoutineRisk = 'low' | 'high'

/** Background tools that act on the machine or on the user's accounts. */
export function routineRisk(tool: string): RoutineRisk {
  // Mouse and keyboard use (the foreground phase) and connector tools (they can send,
  // delete, pay …) until connector annotations rate them individually.
  if (tool === 'request_foreground' || tool.startsWith('mcp__')) return 'high'
  return 'low'
}

function globRe(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*')
  return new RegExp(`^${body}$`, 'i')
}

function valueText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v ?? '')
}

/** True when the call matches the shape: same tool (or `prefix*`) and every listed arg. */
export function matchesShape(shape: ActionShape, tool: string, input: unknown): boolean {
  if (!globRe(shape.tool).test(tool)) return false
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const [k, pattern] of Object.entries(shape.args ?? {})) {
    if (!(k in args) || !globRe(pattern).test(valueText(args[k]))) return false
  }
  return true
}

export function preApproved(shapes: ActionShape[], tool: string, input: unknown): boolean {
  return shapes.some((s) => matchesShape(s, tool, input))
}

/** The shape Settings' "may use the mouse without asking" switch stores. */
export const FOREGROUND_SHAPE: ActionShape = { tool: 'request_foreground' }

export function allowsForeground(shapes: ActionShape[]): boolean {
  return shapes.some((s) => s.tool === FOREGROUND_SHAPE.tool && !s.args)
}

/** Every shape is well formed: a tool name pattern and short string patterns. */
export function validShape(s: unknown): s is ActionShape {
  if (!s || typeof s !== 'object') return false
  const v = s as Partial<ActionShape>
  if (typeof v.tool !== 'string' || !/^[a-z0-9_*-]{1,120}$/i.test(v.tool)) return false
  if (v.args === undefined) return true
  if (!v.args || typeof v.args !== 'object' || Array.isArray(v.args)) return false
  const entries = Object.entries(v.args)
  return (
    entries.length <= 10 &&
    entries.every(
      ([k, p]) => /^[a-z0-9_]{1,60}$/i.test(k) && typeof p === 'string' && p.length <= 500
    )
  )
}

/** Is the user at the PC (own input in the last 2 minutes, not in quiet mode)? */
let userPresent: () => boolean = () => true

/** Wired at start (routines/index): the presence rule for taking the mouse and keyboard. */
export function setPresence(fn: () => boolean): void {
  userPresent = fn
}

/**
 * The background runner's guard for an automation (origin routine): high-risk calls need a
 * matching shape, and the mouse and keyboard (request_foreground) are taken only while the
 * user is at the PC, even when pre-approved.
 */
export function routineGuard(
  shapes: ActionShape[],
  present: () => boolean = () => userPresent()
): (tool: string, input: Record<string, unknown>) => string | null {
  return (tool, input) => {
    if (routineRisk(tool) === 'high' && !preApproved(shapes, tool, input))
      return `an automation skips ${tool} unless it was pre-approved for it (Settings → Automations). Finish and say what is left for the user.`
    if (tool === FOREGROUND_SHAPE.tool && !present())
      return 'the user is away from the PC, so an automation does not use the mouse or keyboard now. Finish and say what is left for the user.'
    return null
  }
}
