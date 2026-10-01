// Voice settings the voice renderer needs beyond the VAD: whisper mode (04 T40), dictation
// sounds and the pill (T47), the hands-free dictation pause (T48).

export interface VoiceExtras {
  whisper: boolean
  /** Dictation start / stop sounds (off in quiet mode). */
  sounds: boolean
  pill: boolean
  /** Hands-free dictation ends after this much silence. */
  dictationSilenceMs: number
}

export const DEFAULT_EXTRAS: VoiceExtras = {
  whisper: false,
  sounds: true,
  pill: true,
  dictationSilenceMs: 2000
}

export function readExtras(cfg: unknown): VoiceExtras {
  const c = cfg as {
    voice?: { whisperMode?: boolean }
    dictation?: { sounds?: boolean; caretPill?: boolean; silenceSec?: number }
    agent?: { background?: { quiet?: boolean } }
  } | null
  const quiet = !!c?.agent?.background?.quiet
  const sec = c?.dictation?.silenceSec
  return {
    whisper: !!c?.voice?.whisperMode,
    sounds: (c?.dictation?.sounds ?? true) && !quiet,
    pill: c?.dictation?.caretPill ?? true,
    dictationSilenceMs:
      typeof sec === 'number' && sec > 0 ? sec * 1000 : DEFAULT_EXTRAS.dictationSilenceMs
  }
}
