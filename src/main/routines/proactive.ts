// Proactive rules (08 T23), now app-trigger automations with a reminder: "when I open Resolve,
// remind me to back up". The agent's focus-changed event is only a hint to ask for the
// foreground window's process and title (watchers.ts). No screenshots, no model calls and no
// activity history.
import type { ProactiveRule } from '@shared/routines'

export const MAX_RULES = 20
/** An app-open automation fires at most once in this long (alt-tabbing stays quiet). */
export const RULE_COOLDOWN_MS = 10 * 60_000
/** Focus events come in bursts; the window is looked at once they settle. */
export const SETTLE_MS = 400

export interface ForegroundInfo {
  title?: string
  process?: string
}

export function normApp(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** "Resolve" ↔ Resolve.exe / "DaVinci Resolve" ↔ Resolve.exe / title "… - Blender". */
export function ruleMatches(app: string, win: ForegroundInfo): boolean {
  const a = normApp(app)
  if (a.length < 2) return false
  const proc = normApp(win.process ?? '')
  if (proc) {
    const compactA = a.replace(/ /g, '')
    const compactP = proc.replace(/ /g, '')
    if (compactP === compactA || compactP.includes(compactA)) return true
    if (compactP.length >= 4 && a.split(' ').some((w) => w === proc)) return true
  }
  const title = ` ${normApp(win.title ?? '')} `
  return title.trim().length > 0 && title.includes(` ${a} `)
}

const RULE_RE =
  /^(?:when(?:ever)?|each time|every time|if) i (?:open|start|launch|switch to|go to|use) (.+?),? (?:then )?(remind me(?: to| that| about)?|tell me(?: to| that)?|say) (.+)$/i

/** "remind me to" + "back up" → "Remember to back up."; "tell me" + "save" → "Save." */
export function reminderLine(verb: string, what: string): string {
  const v = verb.toLowerCase()
  let line = what.trim()
  if (/^remind me( to)?$/.test(v)) line = `Remember to ${line}`
  else if (/^remind me (that|about)$/.test(v)) line = `Reminder: ${line}`
  const say = line.charAt(0).toUpperCase() + line.slice(1)
  return /[.!?]$/.test(say) ? say : `${say}.`
}

/** "when I open Resolve, remind me to back up" → {app: "Resolve", say: "Remember to back up."} */
export function parseProactiveRule(utterance: string): Omit<ProactiveRule, 'id'> | null {
  const m = RULE_RE.exec(
    utterance
      .replace(/[“”"]/g, '')
      .replace(/[.!?]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
  if (!m) return null
  const app = m[1]
    .replace(/^(?:the |my )/i, '')
    .replace(/ (?:app|application|program)$/i, '')
    .trim()
  const what = m[3].trim()
  if (!app || app.length > 60 || !what || what.length > 200) return null
  return { app, say: reminderLine(m[2], what) }
}
