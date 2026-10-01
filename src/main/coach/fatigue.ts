// Adaptive fatigue (11 T18), pure. Local signals in a sliding window turn into proposals;
// nothing changes without a yes. Every answer is remembered: a "no" is not asked again for a
// week, a "yes" never (the change is made, and the user can change it back in Settings).
import type { ConfigV2 } from '@shared/config'

export type FatigueSignal =
  /** A dwell click undone (Ctrl+Z) or escaped within 2 s. */
  | 'dwell-misfire'
  /** "no, I said …", "that's not what I said". */
  | 'voice-correction'
  /** The same request again within a minute, or "try again". */
  | 'retry'
  /** "say that again", "what?" right after Lumen spoke. */
  | 'repeat-request'
  /** Any use of Lumen (time on task). */
  | 'activity'

export type ProposalId = 'bigger-dwell' | 'numbers' | 'more-help' | 'slower-speech' | 'break'

export interface Proposal {
  id: ProposalId
  /** The question asked (yes / no). */
  text: string
  /** Settings change made on yes; none for a break. */
  patch?: Record<string, unknown>
  /** Said after a yes. */
  done: string
}

export interface FatigueState {
  answers: Partial<Record<ProposalId, { answer: 'yes' | 'no'; at: number }>>
}

export const WINDOW_MS = 10 * 60_000
const THRESHOLD = 3
/** Continuous use (no gap over 10 min) before a break is suggested. */
export const BREAK_AFTER_MS = 50 * 60_000
const ACTIVITY_GAP_MS = 10 * 60_000
const NO_AGAIN_MS = 7 * 86_400_000
const RING_UP: Record<string, string> = { s: 'm', m: 'l', l: 'xl', xl: 'xl' }

const CORRECTION_RE =
  /^(?:no[, ]+)?(?:i said|i meant|that's not what i said|that is not what i said|not what i said|you misheard)\b/i
const REPEAT_RE =
  /^(?:say that again|repeat that|what did you say|sorry what|what\??|pardon|come again)$/i
const RETRY_RE = /^(?:try again|again|one more time|do it again)$/i

/** Signals in one utterance (besides activity). */
export function utteranceSignals(
  text: string,
  previous: { text: string; at: number } | null,
  now: number
): FatigueSignal[] {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
  const out: FatigueSignal[] = []
  if (CORRECTION_RE.test(t)) out.push('voice-correction')
  if (REPEAT_RE.test(t)) out.push('repeat-request')
  if (
    RETRY_RE.test(t) ||
    (previous &&
      now - previous.at < 60_000 &&
      previous.text.trim().toLowerCase() === t &&
      t.length > 3)
  )
    out.push('retry')
  return out
}

export class FatigueTracker {
  private events: { s: FatigueSignal; at: number }[] = []
  private activeSince: number | null = null
  private lastActivity = 0
  private breakAskedAt = 0

  constructor(private state: FatigueState) {}

  snapshot(): FatigueState {
    return this.state
  }

  note(s: FatigueSignal, now: number): void {
    if (s === 'activity') {
      if (this.activeSince === null || now - this.lastActivity > ACTIVITY_GAP_MS)
        this.activeSince = now
      this.lastActivity = now
      return
    }
    this.events.push({ s, at: now })
    this.events = this.events.filter((e) => now - e.at <= WINDOW_MS)
  }

  private count(s: FatigueSignal): number {
    return this.events.filter((e) => e.s === s).length
  }

  private askable(id: ProposalId, now: number): boolean {
    const a = this.state.answers[id]
    if (!a) return true
    return a.answer === 'no' && now - a.at > NO_AGAIN_MS
  }

  /** The proposal to ask now, if any (at most one at a time). */
  propose(
    cfg: Pick<ConfigV2, 'dwellClick' | 'a11y' | 'voice' | 'teach'>,
    now: number
  ): Proposal | null {
    const dwell = cfg.a11y.dwell
    if (
      cfg.dwellClick.enabled &&
      this.count('dwell-misfire') >= THRESHOLD &&
      this.askable('bigger-dwell', now)
    ) {
      const ring = RING_UP[dwell.ringSize] ?? 'l'
      const dwellMs = Math.min(4000, cfg.dwellClick.dwellMs + 300)
      return {
        id: 'bigger-dwell',
        text: 'Some dwell clicks seem to miss. Make the dwell ring bigger and wait a little longer before clicking?',
        patch: { a11y: { dwell: { ringSize: ring } }, dwellClick: { dwellMs } },
        done: `Done: a bigger ring and ${(dwellMs / 1000).toFixed(1)} seconds before a click.`
      }
    }
    if (this.count('voice-correction') >= THRESHOLD && this.askable('numbers', now)) {
      return {
        id: 'numbers',
        text: 'I keep mishearing you. Want numbers on the screen, so you can just say a number instead of a name?',
        patch: { a11y: { marks: { keep: true } } },
        done: 'Done. Say “show numbers”, then the number of what you want.'
      }
    }
    if (this.count('retry') >= THRESHOLD && this.askable('more-help', now)) {
      return {
        id: 'more-help',
        text: 'That took a few tries. Want more detailed hints, and me to offer to do steps for you?',
        patch: { teach: { hintLevel: 'detailed' } },
        done: 'Done. Hints will be more detailed. You can always say “do it for me”.'
      }
    }
    if (
      cfg.voice.tts !== 'off' &&
      this.count('repeat-request') >= THRESHOLD &&
      this.askable('slower-speech', now)
    ) {
      const ttsRate = Math.max(0.6, Math.round((cfg.voice.ttsRate - 0.15) * 100) / 100)
      if (ttsRate < cfg.voice.ttsRate)
        return {
          id: 'slower-speech',
          text: 'Should I speak a bit slower?',
          patch: { voice: { ttsRate } },
          done: 'Done, I’ll speak a bit slower.'
        }
    }
    if (
      this.activeSince !== null &&
      now - this.activeSince >= BREAK_AFTER_MS &&
      now - this.breakAskedAt >= BREAK_AFTER_MS &&
      this.state.answers.break?.answer !== 'no'
    ) {
      this.breakAskedAt = now
      return {
        id: 'break',
        text: 'You’ve been at this for nearly an hour. How about a short break?',
        done: 'Good idea. I’ll be here when you’re back.'
      }
    }
    return null
  }

  /** Remembers the answer; the window of signals that led to it starts over. */
  answer(id: ProposalId, yes: boolean, now: number): void {
    this.state = {
      answers: { ...this.state.answers, [id]: { answer: yes ? 'yes' : 'no', at: now } }
    }
    const reset: Partial<Record<ProposalId, FatigueSignal>> = {
      'bigger-dwell': 'dwell-misfire',
      numbers: 'voice-correction',
      'more-help': 'retry',
      'slower-speech': 'repeat-request'
    }
    const s = reset[id]
    if (s) this.events = this.events.filter((e) => e.s !== s)
    if (id === 'break' && yes) this.activeSince = null
  }
}

/** Dwell misfire detection: a dwell click, then Ctrl+Z or Escape within 2 s. */
export class MisfireWatch {
  private lastDwell = -Infinity
  onDwellClick(now: number): void {
    this.lastDwell = now
  }
  onCombo(combo: string, now: number): boolean {
    const c = combo.toLowerCase()
    if ((c === 'ctrl+z' || c === 'escape') && now - this.lastDwell <= 2000) {
      this.lastDwell = -Infinity
      return true
    }
    return false
  }
}
