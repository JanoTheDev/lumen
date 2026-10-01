// The confirm step of the safety policy (safety-policy §5) on top of the assistant bar's
// existing confirm card: Allow once (yes / Do it) · Always for <scope> (voice "always" or the Always button) ·
// Not now (no / Stop). Low and medium get the cancel-window countdown; high never does and
// never offers "always".
import type { Decision } from '../actions/safety'
import { bus } from '../bus'
import { grants } from './grants'

export type ConfirmAnswer = 'once' | 'always' | 'deny'

export interface ConfirmCard {
  summary: string
  risk: 'low' | 'medium' | 'high'
  countdownMs?: number
  /** Set for a grantable medium confirm: the card shows "Always for <label>". */
  alwaysLabel?: string
}

export interface ConfirmUi {
  /** Shows the card; true = confirmed (button, voice yes or countdown end). */
  ask(card: ConfirmCard): Promise<boolean>
  /** Confirms the card that is showing (voice "always"). */
  confirm(): void
  /** Takes the card down unanswered (a timed-out confirm of an unattended task). */
  dismiss?(): void
}

let ui: ConfirmUi | null = null
let lastRequest: string | undefined
bus.on('query.started', (e) => (lastRequest = e.prompt))

/** The user's last request (policy ctx.userText for answer-mode actions). */
export function lastUserRequest(): string | undefined {
  return lastRequest
}

let pending: { scope?: string; always: boolean } | null = null

/** index.ts wires the assistant bar; without a UI every confirm is a no (fail closed). */
export function setConfirmUi(next: ConfirmUi | null): void {
  ui = next
}

/** "app:outlook.exe" → "Outlook"; "domain:github.com" → "github.com". */
export function scopeLabel(scope: string): string {
  const [kind, rest] = [scope.slice(0, scope.indexOf(':')), scope.slice(scope.indexOf(':') + 1)]
  if (kind === 'app') {
    const base = rest.replace(/\.exe$/i, '')
    return base.charAt(0).toUpperCase() + base.slice(1)
  }
  if (kind === 'scheme') return `${rest} links`
  return rest
}

/** The card text: what will happen, the masked secrets, and the "always" hint when grantable. */
export function confirmSummary(what: string, d: Decision): string {
  const parts = [what.trim().replace(/\.$/, '') + '.']
  if (d.reason && !what.includes(d.reason)) parts.push(`Why I ask: ${d.reason}.`)
  if (d.risk === 'medium' && d.grantScope)
    parts.push(`Say “always” to allow ${scopeLabel(d.grantScope)} from now on.`)
  return parts.join(' ')
}

/**
 * Asks the user about one decision. "always" stores the grant (medium only). `timeoutMs`: an
 * unattended task's confirm counts as a no when nobody answers in time (the card goes away).
 */
export async function askUser(
  what: string,
  d: Decision,
  countdownMs?: number,
  timeoutMs?: number
): Promise<ConfirmAnswer> {
  if (!ui || d.risk === 'blocked') return 'deny'
  const risk = d.risk
  const p = { scope: risk === 'medium' ? d.grantScope : undefined, always: false }
  pending = p
  const shown = ui
  let timer: NodeJS.Timeout | undefined
  try {
    const asked = shown.ask({
      summary: confirmSummary(what, d),
      risk,
      countdownMs: risk === 'high' ? undefined : countdownMs,
      alwaysLabel: p.scope ? scopeLabel(p.scope) : undefined
    })
    const ok = timeoutMs
      ? await Promise.race([
          asked,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => {
              shown.dismiss?.()
              resolve(false)
            }, timeoutMs)
          })
        ])
      : await asked
    if (!ok) return 'deny'
    if (p.always && p.scope && grants().add(p.scope, risk)) return 'always'
    return 'once'
  } finally {
    if (timer) clearTimeout(timer)
    if (pending === p) pending = null
  }
}

const ALWAYS_RE =
  /^(always|always allow|allow always|always do it|yes always|always yes|always for this (app|site|tool))$/

/**
 * Voice "always" while a grantable confirm waits: confirms it and stores the grant. Runs before
 * the transcript's yes/no handling so "always" is not taken as a new request.
 */
export function answerAlways(utterance: string): boolean {
  if (!pending?.scope || !ui) return false
  const words = utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!ALWAYS_RE.test(words)) return false
  return confirmAlways()
}

/** The card's Always button: confirms a grantable confirm and stores the grant. */
export function confirmAlways(): boolean {
  if (!pending?.scope || !ui) return false
  pending.always = true
  ui.confirm()
  return true
}
