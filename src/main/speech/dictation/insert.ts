// Types dictated text into the focused field through the agent's `type` (SendInput unicode,
// no clipboard). The terminal guard runs first; the agent re-checks the foreground window.
import type { AgentAction } from '../../actions/agent-action'
import type { AgentBridge } from '../../agent/bridge'
import { guardText, type FocusTarget, type TerminalPolicy } from './terminal-guard'

const FOCUS_TIMEOUT_MS = 1200

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Focused window + element. Falls back to the title only when the agent has no focus_info. */
export async function readFocus(agent: AgentBridge): Promise<FocusTarget> {
  try {
    const r = await agent.request<Record<string, unknown>>(
      'focus_info',
      {},
      { timeoutMs: FOCUS_TIMEOUT_MS }
    )
    return {
      process: str(r?.process).toLowerCase(),
      title: str(r?.title),
      uia: r?.uia === true,
      role: str(r?.role),
      name: str(r?.name),
      editable: r?.editable === true,
      password: r?.password === true,
      valueTail: str(r?.valueTail)
    }
  } catch (e) {
    console.warn('[dictation] focus_info unavailable:', (e as Error).message)
    const title = await agent.activeWindow().catch(() => '')
    return {
      process: '',
      title,
      uia: false,
      role: '',
      name: '',
      editable: false,
      password: false,
      valueTail: ''
    }
  }
}

/** A space before the text when it would otherwise glue onto the previous word. */
export function withJoiningSpace(text: string, valueTail: string): string {
  if (!valueTail || /\s$/.test(valueTail) || /^[\s,.;:!?)\]}]/.test(text)) return text
  return ` ${text}`
}

export type InsertResult =
  | { ok: true; terminal: boolean; notice?: string }
  /** `refused`: not typed on purpose (password field, blocked terminal), never an error. */
  | { ok: false; notice: string; refused?: 'password' | 'terminal' }

export const PASSWORD_NOTICE = 'Dictation does not type into password fields.'

/** The agent refused the input (its terminal / IDE guard), said plainly. */
export function deniedNotice(message: string): string {
  const reason = message.replace(/^\w+ denied:\s*/i, '').trim()
  return `Not typed, for safety (${reason || 'the app may have a terminal focused'}). The text is kept below to copy.`
}

/** Text split on line breaks into typed parts and Shift+Enter presses (for chat apps). */
export function softBreakActions(text: string, allowTerminal: boolean): AgentAction[] {
  const out: AgentAction[] = []
  text.split(/\r?\n/).forEach((part, i) => {
    if (i > 0) out.push({ type: 'hotkey', keys: ['shift', 'enter'] })
    if (part) out.push({ type: 'type', text: part, allowTerminal } as AgentAction)
  })
  return out
}

export async function insertDictation(
  agent: AgentBridge,
  text: string,
  target: FocusTarget,
  policy: TerminalPolicy,
  opts: { softBreaks?: boolean } = {}
): Promise<InsertResult> {
  if (target.password) return { ok: false, notice: PASSWORD_NOTICE, refused: 'password' }
  const decision = guardText(text, target, policy)
  if (decision.kind === 'block') return { ok: false, notice: decision.notice, refused: 'terminal' }
  const typed = decision.terminal
    ? decision.text
    : withJoiningSpace(decision.text, target.valueTail)
  if (!typed.trim()) return { ok: true, terminal: decision.terminal }
  // allowTerminal only after the guard removed every line break.
  const action = { type: 'type', text: typed, allowTerminal: decision.terminal }
  // Enter sends in chat apps: line breaks go in as Shift+Enter there.
  const actions =
    opts.softBreaks && !decision.terminal && /\n/.test(typed)
      ? softBreakActions(typed, false)
      : [action as AgentAction]
  try {
    for (const a of actions) await agent.execute(a)
  } catch (e) {
    const err = e as Error & { code?: string }
    if (err.code === 'E_DENIED') {
      // A password field the focus read missed: never shown or kept.
      if (/password/i.test(err.message))
        return { ok: false, notice: PASSWORD_NOTICE, refused: 'password' }
      return { ok: false, notice: deniedNotice(err.message), refused: 'terminal' }
    }
    return { ok: false, notice: `Could not type the dictation: ${err.message}` }
  }
  return decision.notice
    ? { ok: true, terminal: decision.terminal, notice: decision.notice }
    : { ok: true, terminal: decision.terminal }
}
