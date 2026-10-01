// Deictic voice (11 T15) without Electron: the pointer ring, the timing of the last spoken
// utterance and what "click this" / "move this there" / "what's that" do with them. Points are
// physical px (the agent's space). A typed command has no timing: "this" is where the pointer
// is now, and "move this there" needs speech (two moments).
import type { Action, Point } from '@shared/types'
import { wordTimes, type UtteranceTiming } from './align'
import { PointerRing } from './buffer'
import { parseDeictic, words, type DeicticCommand } from './grammar'

/** The spoken utterance counts as the one being handled this long after it ended. */
export const UTTERANCE_TTL_MS = 30_000
/** Two points closer than this are one place. */
export const SAME_PLACE_PX = 12
/** "what's this" with files shared counts as pointing only after a move this recent. */
export const POINTED_MS = 5000

export interface DeicticDeps {
  now(): number
  enabled(): boolean
  /** The pointer now (physical px). */
  cursor(): Point
  /** Runs the actions through the executor (safety policy + audit); true when they ran. */
  run(actions: Action[], userText: string): Promise<{ ok: boolean; why?: string }>
  /** "what's that": a spoken explanation of what is at the point. */
  explain(p: Point): Promise<string>
  /** "what's this" is about dropped files rather than the screen (files/ decides). */
  aboutFiles?(utterance: string, pointedRecently: boolean): boolean
  log(msg: string): void
  handled: unknown
}

type Reply = { mode: 'answer'; text: string }
const answer = (text: string): Reply => ({ mode: 'answer', text })

export class Deictic {
  readonly ring = new PointerRing()
  private recording: number | null = null
  private last: UtteranceTiming | null = null

  constructor(private readonly deps: DeicticDeps) {}

  onPointer(p: Point): void {
    this.ring.push({ t: this.deps.now(), x: p.x, y: p.y })
  }

  onVoiceStarted(): void {
    this.recording = this.deps.now()
  }

  onVoiceStopped(): void {
    if (this.recording === null) return
    this.last = { start: this.recording, end: this.deps.now() }
    this.recording = null
  }

  onVoiceCancelled(): void {
    this.recording = null
  }

  /** Word timestamps from an engine that has them (none of Lumen's do yet). */
  setWordTimes(times: { start: number; end: number }[]): void {
    if (this.last) this.last = { ...this.last, words: times }
  }

  /** The pointer moved within the last few seconds. */
  pointedRecently(ms = POINTED_MS): boolean {
    const list = this.ring.samples()
    const lastAt = list.length ? list[list.length - 1].t : -Infinity
    return this.deps.now() - lastAt <= ms
  }

  /** The spoken utterance this command came from, or null (typed / too old). */
  private timing(): UtteranceTiming | null {
    const t = this.last
    if (!t || this.deps.now() - t.end > UTTERANCE_TTL_MS) return null
    return t
  }

  /** Where each pointing word of `cmd` was aimed; null when it cannot tell. */
  points(cmd: DeicticCommand, utterance: string): Point[] | null {
    const timing = this.timing()
    const now = this.deps.now()
    if (!timing) return cmd.refs.length === 1 ? [this.deps.cursor()] : null
    const times = wordTimes(words(utterance), timing)
    return cmd.refs.map((i) => {
      const wt = times[i] ?? times[times.length - 1]
      return (
        (wt && this.ring.heldNear(wt.t, wt.slack, now)) ?? this.ring.at(now) ?? this.deps.cursor()
      )
    })
  }

  /** The command's response (or its promise), undefined when it is not a deictic command. */
  intercept(utterance: string): unknown | undefined {
    if (!this.deps.enabled()) return undefined
    const cmd = parseDeictic(utterance)
    if (!cmd) return undefined
    if (cmd.kind === 'what' && this.deps.aboutFiles?.(utterance, this.pointedRecently()))
      return undefined
    const pts = this.points(cmd, utterance)
    this.last = null
    if (!pts)
      return answer(
        'Say it while you point: “move this” with the pointer on the thing, then “there” with the pointer where it goes.'
      )
    const fmt = (p: Point): string => `${Math.round(p.x)},${Math.round(p.y)}`
    this.deps.log(`deictic ${cmd.kind} at ${pts.map(fmt).join(' → ')}`)
    const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) })
    switch (cmd.kind) {
      case 'click': {
        const p = round(pts[0])
        return this.act(
          [
            {
              type: 'input',
              steps: [
                {
                  t: 'click',
                  button: cmd.button,
                  x: p.x,
                  y: p.y,
                  ...(cmd.count > 1 ? { count: 2 } : {})
                }
              ]
            }
          ],
          utterance
        )
      }
      case 'drag': {
        const [from, to] = pts.map(round)
        if (Math.hypot(from.x - to.x, from.y - to.y) < SAME_PLACE_PX)
          return answer(
            'The pointer stayed in one place. Point at the thing as you say “this”, then where it goes as you say “there”.'
          )
        return this.act([{ type: 'input', steps: [{ t: 'drag', from, to }] }], utterance)
      }
      case 'what':
        return this.deps
          .explain(round(pts[0]))
          .then(answer)
          .catch(() => answer('I could not tell what that is.'))
    }
  }

  private act(actions: Action[], utterance: string): Promise<unknown> {
    return this.deps
      .run(actions, utterance)
      .then((r) => (r.ok ? this.deps.handled : answer(r.why ?? 'I did not do that.')))
      .catch(() => answer('That did not work.'))
  }
}
