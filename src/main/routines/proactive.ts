// Proactive mode (08 T23): opt-in, off by default, local only. The only triggers are the
// user's own rules ("when I open Resolve, remind me to back up") and the lesson idle hint
// (07, teach.idleHint). A rule watches which app is in front: the agent's focus-changed
// event is only a hint to ask for the foreground window's process and title. No screenshots,
// no model calls and no activity history; with the mode off nothing is subscribed or asked.
import type { ProactiveRule } from '@shared/routines'

export const MAX_RULES = 20
/** A rule speaks at most once in this long (alt-tabbing back and forth stays quiet). */
export const RULE_COOLDOWN_MS = 10 * 60_000
/** Focus events come in bursts; the window is looked at once they settle. */
export const SETTLE_MS = 400

export interface ForegroundInfo {
  title?: string
  process?: string
}

export interface ProactivePorts {
  enabled(): boolean
  rules(): ProactiveRule[]
  /** Asks for (or releases) the agent's focus-changed events. */
  subscribe(on: boolean): void
  /** Title + process of the foreground window (no capture). */
  foreground(): Promise<ForegroundInfo>
  say(text: string): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** "Resolve" ↔ Resolve.exe / "DaVinci Resolve" ↔ Resolve.exe / title "… - Blender". */
export function ruleMatches(app: string, win: ForegroundInfo): boolean {
  const a = norm(app)
  if (a.length < 2) return false
  const proc = norm(win.process ?? '')
  if (proc) {
    const compactA = a.replace(/ /g, '')
    const compactP = proc.replace(/ /g, '')
    if (compactP === compactA || compactP.includes(compactA)) return true
    if (compactP.length >= 4 && a.split(' ').some((w) => w === proc)) return true
  }
  const title = ` ${norm(win.title ?? '')} `
  return title.trim().length > 0 && title.includes(` ${a} `)
}

const RULE_RE =
  /^(?:when(?:ever)?|each time|every time|if) i (?:open|start|launch|switch to|go to|use) (.+?),? (?:then )?(remind me(?: to| that| about)?|tell me(?: to| that)?|say) (.+)$/i

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
  let what = m[3].trim()
  if (!app || app.length > 60 || !what || what.length > 200) return null
  const verb = m[2].toLowerCase()
  if (/^remind me( to)?$/.test(verb)) what = `Remember to ${what}`
  else if (/^remind me (that|about)$/.test(verb)) what = `Reminder: ${what}`
  const say = what.charAt(0).toUpperCase() + what.slice(1)
  return { app, say: /[.!?]$/.test(say) ? say : `${say}.` }
}

export class ProactiveWatcher {
  private subscribed = false
  private timer: unknown = null
  private lastKey = ''
  private lastSaid = new Map<string, number>()
  private checking = false

  constructor(private readonly p: ProactivePorts) {}

  /** Live while the mode is on and there is a rule; call on start and on every config change. */
  active(): boolean {
    return this.p.enabled() && this.p.rules().length > 0
  }

  sync(): void {
    const on = this.active()
    if (on === this.subscribed) return
    this.subscribed = on
    this.p.subscribe(on)
    if (!on) {
      if (this.timer !== null) this.p.clearTimer(this.timer)
      this.timer = null
      this.lastKey = ''
    }
  }

  /** The agent's focus-changed event (only arrives while subscribed). */
  onFocusChanged(): void {
    if (!this.subscribed || !this.active()) return
    if (this.timer !== null) this.p.clearTimer(this.timer)
    this.timer = this.p.setTimer(() => {
      this.timer = null
      void this.check()
    }, SETTLE_MS)
  }

  private async check(): Promise<void> {
    if (this.checking || !this.active()) return
    this.checking = true
    try {
      const win = await this.p.foreground().catch(() => ({}) as ForegroundInfo)
      const key = `${norm(win.process ?? '')}|${win.process ? '' : norm(win.title ?? '')}`
      if (!win.process && !win.title) return
      // Only a change of app counts, not focus moving inside it.
      if (key === this.lastKey) return
      this.lastKey = key
      if (!this.active()) return
      const now = this.p.now()
      for (const r of this.p.rules()) {
        if (!ruleMatches(r.app, win)) continue
        const last = this.lastSaid.get(r.id)
        if (last !== undefined && now - last < RULE_COOLDOWN_MS) continue
        this.lastSaid.set(r.id, now)
        this.p.say(r.say)
      }
    } finally {
      this.checking = false
    }
  }
}
