// Start / stop sounds for dictation (04 T47): two short sine blips made with WebAudio, no
// files. Quiet (about -20 dBFS), under 0.2 s, played in the voice renderer so the mic's echo
// canceller hears them. Off with dictation.sounds or quiet mode; the caller decides.

export type Earcon = 'start' | 'stop'

export interface Tone {
  /** Hz. */
  freq: number
  /** Seconds from the earcon's start. */
  at: number
  /** Seconds. */
  dur: number
}

/** Rising for start, falling for stop. Pure. */
export function earconTones(kind: Earcon): Tone[] {
  const [a, b] = kind === 'start' ? [660, 880] : [880, 587]
  return [
    { freq: a, at: 0, dur: 0.07 },
    { freq: b, at: 0.08, dur: 0.09 }
  ]
}

export const EARCON_GAIN = 0.1

let ctx: AudioContext | null = null

export function playEarcon(kind: Earcon): void {
  try {
    ctx ??= new AudioContext()
    const ac = ctx
    if (ac.state === 'suspended') ac.resume().catch(() => {})
    const t0 = ac.currentTime + 0.01
    for (const tone of earconTones(kind)) {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = tone.freq
      // Short attack and release: no clicks.
      const start = t0 + tone.at
      const end = start + tone.dur
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(EARCON_GAIN, start + 0.01)
      gain.gain.setValueAtTime(EARCON_GAIN, end - 0.02)
      gain.gain.linearRampToValueAtTime(0, end)
      osc.connect(gain).connect(ac.destination)
      osc.start(start)
      osc.stop(end + 0.01)
    }
  } catch (err) {
    console.warn('[voice] earcon failed:', err)
  }
}
