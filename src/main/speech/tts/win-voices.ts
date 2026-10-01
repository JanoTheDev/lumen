// Windows voices as audio data. The native agent runs the WinRT SpeechSynthesizer (the same
// OneCore voices speechSynthesis lists) and returns WAV per sentence, so the voice renderer
// can play it through WebAudio, where Chromium's echo cancellation hears it (barge-in). The
// agent also reads and clears the output mute (muted-output fallback). Without an agent that
// reports `tts`, callers fall back to the renderer's speechSynthesis.
import type { AgentBridge } from '../../agent/bridge'
import {
  audioOutput,
  audioUnmute,
  ttsSynthesize,
  ttsVoices,
  type AudioOutputState,
  type TtsVoice
} from '../../agent/commands'

export type WinVoice = Pick<TtsVoice, 'id' | 'name' | 'lang'>
export type OutputState = AudioOutputState

/**
 * The installed voice for a configured name. Chromium lists "Microsoft David - English (United
 * States)" where WinRT says "Microsoft David", so a prefix match counts. Else the first English
 * voice, else the first one (null = the system default).
 */
export function pickWinVoice(voices: readonly WinVoice[], name: string): WinVoice | null {
  const want = name.trim().toLowerCase()
  if (want) {
    const exact = voices.find((v) => v.name.toLowerCase() === want)
    if (exact) return exact
    const prefixed = voices
      .filter((v) => want.startsWith(v.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (prefixed) return prefixed
  }
  return voices.find((v) => v.lang.toLowerCase().startsWith('en')) ?? voices[0] ?? null
}

/** WinRT SpeakingRate range is 0.5–6. */
export function winRate(rate: number): number {
  return Math.max(0.5, Math.min(6, Number.isFinite(rate) ? rate : 1))
}

export class WinVoices {
  private voiceList: { bridge: AgentBridge; list: Promise<WinVoice[]> } | null = null

  constructor(private readonly agent: () => AgentBridge | null) {}

  /** The running agent can synthesize; otherwise use speechSynthesis. */
  get usable(): boolean {
    return !!this.agent()?.hasCapability('tts')
  }

  /** The running agent can read and clear the output mute. */
  get canCheckOutput(): boolean {
    return !!this.agent()?.hasCapability('audio-output')
  }

  /** WAV bytes (base64) for one sentence. Aborting `signal` cancels the agent call. */
  async synth(
    text: string,
    voiceName: string,
    rate: number,
    signal?: AbortSignal
  ): Promise<string> {
    const bridge = this.bridge()
    const voice = pickWinVoice(await this.voices(), voiceName)
    const r = await ttsSynthesize(
      bridge,
      { text, voice: voice?.id ?? '', rate: winRate(rate) },
      { signal }
    )
    if (typeof r?.data !== 'string' || !r.data) throw new Error('no audio')
    return r.data
  }

  async voices(): Promise<WinVoice[]> {
    const bridge = this.bridge()
    if (this.voiceList?.bridge !== bridge) {
      const list = ttsVoices(bridge).catch((e: unknown) => {
        if (this.voiceList?.list === list) this.voiceList = null
        throw e
      })
      this.voiceList = { bridge, list }
    }
    return this.voiceList.list
  }

  async outputState(timeoutMs: number): Promise<OutputState> {
    const r = await audioOutput(this.bridge(), { timeoutMs })
    return { muted: r?.muted === true, volume: typeof r?.volume === 'number' ? r.volume : 1 }
  }

  async unmute(): Promise<void> {
    await audioUnmute(this.bridge())
  }

  /** Loads the voice list ahead of the first sentence. */
  warm(): void {
    if (this.usable) void this.voices().catch(() => {})
  }

  private bridge(): AgentBridge {
    const bridge = this.agent()
    if (!bridge) throw new Error('Windows voices need the agent')
    return bridge
  }
}
