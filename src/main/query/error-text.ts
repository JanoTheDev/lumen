// The status line (spoken through the announce policy) for a turn that failed: plain words the
// user can act on, never an internal code.
import { AGENT_DOWN_TEXT } from '../agent/instance'

const AGENT_DOWN_CODES = new Set(['E_AGENT_MISSING', 'E_AGENT_NOT_RUNNING'])

function messageOf(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m.trim() : ''
}

/** The native agent is missing or not running (its process, not the request, failed). */
export function isAgentDown(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return (
    (typeof code === 'string' && AGENT_DOWN_CODES.has(code)) ||
    /^agent not (?:ready|running)\b/i.test(messageOf(e))
  )
}

/** The line to show and speak for a failed query. */
export function queryErrorText(e: unknown): string {
  if (isAgentDown(e)) return AGENT_DOWN_TEXT
  const message = messageOf(e)
  if (!message) return 'Something went wrong. Please try again.'
  return `Something went wrong: ${message.replace(/[.\s]+$/, '')}.`
}

/** Long lines stay up long enough to be read. */
export function errorHoldMs(text: string): number {
  return Math.min(10_000, Math.max(3000, text.length * 70))
}
