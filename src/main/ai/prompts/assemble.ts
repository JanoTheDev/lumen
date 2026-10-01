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
  /** Every frame sent, in image order, when more than one monitor is captured. */
  screens?: { label: string; name: string; w: number; h: number }[]
  /** Mode chosen before the call (router or pipeline); the model does not re-decide it. */
  routedMode?: string
  /** App to switch to first (router appSwitch); url when it is a known web app. */
  targetApp?: { name: string; url?: string }
  /** Compact UIA elements list (C3 lines, rects in frame "1" px). */
  elements?: string
  /** Number of set-of-marks boxes drawn on frame "1". */
  marks?: number
  /** Skill pack of the foreground app: overview + shortcuts excerpt, already capped. */
  skill?: { name: string; text: string }
  /** Region names of that pack, for {"kind":"region"} targets. */
  regions?: string
  /** `<memory>` block about the user (capped by the memory module). */
  memory?: string
  /** The running lesson (07), one line. */
  lesson?: string
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
    ctx.screens && ctx.screens.length > 1
      ? `screens: ${ctx.screens.map((s) => `frame "${s.label}" = ${s.name}, ${s.w}x${s.h} px`).join('; ')}. Images are in frame order; frame "1" has the foreground window. Point and rect targets name the frame they are on.`
      : ctx.frame
        ? `screen: frame "1", ${ctx.frame.w}x${ctx.frame.h} px`
        : 'screen: none sent'
  ]
  if (ctx.routedMode) lines.push(`routed_mode: ${ctx.routedMode}`)
  if (ctx.targetApp)
    lines.push(
      `target_app: ${ctx.targetApp.name}${ctx.targetApp.url ? ` ${ctx.targetApp.url}` : ''} (not in front)`
    )
  lines.push(`app_style: ${writingRulesFor(ctx.activeWindow)}`)
  if (ctx.lesson) lines.push(ctx.lesson)
  if (ctx.marks)
    lines.push(
      `marks: ${ctx.marks} numbered boxes drawn on frame "1" (text and unlabelled controls); point at them with {"kind":"mark","n":N}`
    )
  if (ctx.regions)
    lines.push(
      `regions: ${ctx.regions} (named areas of the ${ctx.skill?.name ?? 'app'} window; point at one with {"kind":"region","name":"..."} when nothing more exact is visible)`
    )
  if (ctx.elements)
    lines.push(`elements (id role "name" @(x,y,w,h) in frame "1" px):
${ctx.elements}`)
  const skill = ctx.skill?.text
    ? `\n<app_guide app="${ctx.skill.name}">\n${ctx.skill.text}\n</app_guide>`
    : ''
  const memory = ctx.memory ? `\n${ctx.memory}` : ''
  return `<context>\n${lines.join('\n')}\n</context>${memory}${skill}\n<request>${ctx.prompt}</request>`
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
