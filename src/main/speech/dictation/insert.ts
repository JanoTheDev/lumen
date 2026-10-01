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
  | { ok: false; notice: string }

export const PASSWORD_NOTICE = 'Dictation does not type into password fields.'

export async function insertDictation(
  agent: AgentBridge,
  text: string,
  target: FocusTarget,
  policy: TerminalPolicy
): Promise<InsertResult> {
  if (target.password) return { ok: false, notice: PASSWORD_NOTICE }
  const decision = guardText(text, target, policy)
  if (decision.kind === 'block') return { ok: false, notice: decision.notice }
  const typed = decision.terminal
    ? decision.text
    : withJoiningSpace(decision.text, target.valueTail)
  if (!typed.trim()) return { ok: true, terminal: decision.terminal }
  // allowTerminal only after the guard removed every line break.
  const action = { type: 'type', text: typed, allowTerminal: decision.terminal }
  try {
    await agent.execute(action as AgentAction)
  } catch (e) {
    return { ok: false, notice: `Could not type the dictation: ${(e as Error).message}` }
  }
  return decision.terminal
    ? { ok: true, terminal: true, notice: decision.notice }
    : { ok: true, terminal: false }
}
