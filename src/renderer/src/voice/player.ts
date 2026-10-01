// Spoken-reply player: a gapless WebAudio queue in the voice renderer. Playing through
// WebAudio (not speechSynthesis) keeps the audio in Chromium's output path, so the echo
// canceller on the shared mic hears it and removes it (needed for barge-in).
//
// Chunks arrive in order (main chains them); decoding is async, so it is chained too. Each
// chunk is scheduled right where the previous one ends. stop() fades out over 30 ms.

/** Start this far ahead of "now" so the first chunk is not clipped. */
const LEAD_S = 0.02
export const FADE_S = 0.03
/** A gap between chunks shorter than this still counts as speaking (synthesis lagging). */
export const SPEAKING_HOLD_MS = 400

/** How one queued chunk ended: played out, stopped (stop() or dropped), or failed to decode. */
export type ChunkEnd = 'ended' | 'stopped' | 'failed'

/** The subset of AudioContext the player uses (a fake in tests). */
export interface PlayerContext {
  readonly currentTime: number
  readonly destination: AudioNode
  readonly state: string
  resume(): Promise<void>
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>
  createGain(): GainNode
  createBufferSource(): AudioBufferSourceNode
}

/** When the next chunk starts: right after the queue, never in the past. */
export function nextStart(now: number, queueEnd: number, lead = LEAD_S): number {
  return Math.max(now + lead, queueEnd)
}

export class TtsPlayer {
  private ctx: PlayerContext | null = null
  private gain: GainNode | null = null
  /** Playing / scheduled sources and who wants to know when each one ends. */
  private sources = new Map<AudioBufferSourceNode, ((end: ChunkEnd) => void) | undefined>()
  private queueEnd = 0
  private generation = 0
  private chain: Promise<void> = Promise.resolve()
  private isSpeaking = false
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<(speaking: boolean) => void>()

  constructor(private readonly makeContext: () => PlayerContext = () => new AudioContext()) {}

  get speaking(): boolean {
    return this.isSpeaking
  }

  /** Called with true when audio starts and false when the queue runs dry or stops. */
  onSpeakingChange(cb: (speaking: boolean) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /**
   * Queues one encoded chunk (WAV, MP3). Resolves once it is scheduled or dropped. `onEnd` is
   * called once: when the chunk has played out, was stopped / dropped, or failed to decode.
   */
  enqueue(data: ArrayBuffer, onEnd?: (end: ChunkEnd) => void): Promise<void> {
    const gen = this.generation
    this.chain = this.chain
      .then(async () => {
        if (gen !== this.generation) return onEnd?.('stopped')
        const ctx = this.context()
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
        const buffer = await ctx.decodeAudioData(data)
        if (gen !== this.generation) return onEnd?.('stopped')
        this.schedule(ctx, buffer, onEnd)
      })
      .catch((err) => {
        console.warn('[player] chunk dropped:', err)
        onEnd?.('failed')
      })
    return this.chain
  }

  /** Fades out and drops everything queued, including chunks still decoding. */
  stop(): void {
    this.generation++
    this.chain = Promise.resolve()
    const ctx = this.ctx
    const gain = this.gain
    if (ctx && gain && this.sources.size) {
      const t = ctx.currentTime
      gain.gain.cancelScheduledValues(t)
      gain.gain.setValueAtTime(gain.gain.value, t)
      gain.gain.linearRampToValueAtTime(0, t + FADE_S)
      for (const s of this.sources.keys()) {
        s.onended = null
        try {
          s.stop(t + FADE_S)
        } catch {
          /* not started */
        }
      }
      // Later chunks get a fresh gain at full volume.
      this.gain = null
    }
    const ends = [...this.sources.values()]
    this.sources.clear()
    this.queueEnd = 0
    this.setSpeaking(false)
    for (const end of ends) end?.('stopped')
  }

  private context(): PlayerContext {
    if (!this.ctx) this.ctx = this.makeContext()
    return this.ctx
  }

  private output(ctx: PlayerContext): GainNode {
    if (!this.gain) {
      this.gain = ctx.createGain()
      this.gain.connect(ctx.destination)
    }
    return this.gain
  }

  private schedule(ctx: PlayerContext, buffer: AudioBuffer, onEnd?: (end: ChunkEnd) => void): void {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.output(ctx))
    const at = nextStart(ctx.currentTime, this.queueEnd)
    this.queueEnd = at + buffer.duration
    this.sources.set(src, onEnd)
    src.onended = () => {
      this.sources.delete(src)
      onEnd?.('ended')
      if (this.sources.size > 0 || this.quietTimer) return
      this.quietTimer = setTimeout(() => {
        this.quietTimer = null
        if (this.sources.size === 0) this.setSpeaking(false)
      }, SPEAKING_HOLD_MS)
    }
    src.start(at)
    this.setSpeaking(true)
  }

  private setSpeaking(on: boolean): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = null
    if (on === this.isSpeaking) return
    this.isSpeaking = on
    for (const cb of this.listeners) cb(on)
  }
}
