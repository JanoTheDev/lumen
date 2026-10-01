// Builds one request: a stable, cacheable system prefix (core + grounding + every mode
// contract, byte-identical for the whole session) and a volatile user turn (<context> +
// <request>). Anything that changes per call goes in the user turn, never the prefix.
import type { SystemBlock } from '../providers/types'
import { writingRulesFor } from './apps'
import { CORE } from './core'
import { GROUNDING } from './grounding'
import { MODES } from './modes'

export const SYSTEM_PREFIX = [CORE, GROUNDING, `Modes:\n\n${MODES}`].join('\n\n')

/** The system prompt: one cacheable block. */
export function systemBlocks(): SystemBlock[] {
  return [{ text: SYSTEM_PREFIX, cacheable: true }]
}

export interface TurnContext {
  prompt: string
  activeWindow: string
  /** Size of screenshot frame "1" in image px, or null when no screenshot is sent. */
  frame: { w: number; h: number } | null
  /** Mode chosen before the call (router or pipeline); the model does not re-decide it. */
  routedMode?: string
  /** App to switch to first (router appSwitch); url when it is a known web app. */
  targetApp?: { name: string; url?: string }
  now?: Date
}

function formatNow(now: Date): string {
  const when = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return zone ? `${when} (${zone})` : when
}

/** The volatile user turn: context lines, then the user's request verbatim. */
export function userTurn(ctx: TurnContext): string {
  const lines = [
    `time: ${formatNow(ctx.now ?? new Date())}`,
    `foreground: ${ctx.activeWindow || 'unknown'}`,
    ctx.frame ? `screen: frame "1", ${ctx.frame.w}x${ctx.frame.h} px` : 'screen: none sent'
  ]
  if (ctx.routedMode) lines.push(`routed_mode: ${ctx.routedMode}`)
  if (ctx.targetApp)
    lines.push(
      `target_app: ${ctx.targetApp.name}${ctx.targetApp.url ? ` ${ctx.targetApp.url}` : ''} (not in front)`
    )
  lines.push(`app_style: ${writingRulesFor(ctx.activeWindow)}`)
  return `<context>\n${lines.join('\n')}\n</context>\n<request>${ctx.prompt}</request>`
}

/** Rough token count (about 3.5 characters per token for English prose and JSON). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

let prefixLogged = false

/** Logs the prefix size once per session. */
export function logPrefixSize(): void {
  if (prefixLogged) return
  prefixLogged = true
  console.log(`[prompt] system prefix ~${estimateTokens(SYSTEM_PREFIX)} tokens (cacheable)`)
}
