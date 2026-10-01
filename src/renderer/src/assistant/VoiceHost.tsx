// Voice session controller of the assistant window: records on `voice:start`, transcribes,
// sends the query (or dictation) to main and runs what comes back. Draws nothing; the bar
// shows the state main pushes and reads the input level from --voice-level.
import { useEffect, useRef } from 'react'
import type { ModelResponse } from '@shared/types'
import { useVoice, shouldDropTranscript, type VoiceResultInfo } from '../voice/useVoice'
import { startSpeaker } from '../voice/speaker'
import { startBargeIn, takePreRoll } from '../voice/barge-in'
import { setWakeFeedPaused, startWakeFeed } from '../voice/wake-feed'
import { startMicDeviceSync } from '../voice/mic'
import { RmsGate } from '../voice/vad/rms'
import { playEarcon } from '../voice/earcons'
import { whisperThreshold } from '../voice/whisper'
import { DEFAULT_EXTRAS, readExtras, type VoiceExtras } from '../voice/extras'

interface VadConfig {
  speechThreshold: number
  silenceMs: number
  maxWaitMs: number
  maxRecordMs?: number
}

type QueryResult = ModelResponse & { url?: string; cancelled?: boolean; dictated?: boolean }

const DEFAULT_VAD: VadConfig = { speechThreshold: 0.04, silenceMs: 1500, maxWaitMs: 8000 }
const DEFAULT_MAX_RECORD_MS = 30000
// Dictation: held up to 10 min; hands-free ends after a longer pause than a query.
const DICTATION_MAX_RECORD_MS = 10 * 60_000
const DICTATION_HANDS_FREE_MAX_MS = 3 * 60_000
const PROCESSING_TIMEOUT_MS = 60_000

const NOTHING_HEARD = 'Didn’t catch that. Try again.'

const lumen = (): Window['lumen'] => window.lumen

function readVad(cfg: unknown): VadConfig | null {
  return (cfg as { vad?: VadConfig } | null)?.vad ?? null
}

/** The bar draws the compact dictation pill while this is set (assistant.css). */
function setPill(on: boolean): void {
  if (on) document.documentElement.dataset.dictating = 'pill'
  else delete document.documentElement.dataset.dictating
}

function closeBar(): void {
  lumen().send('assistant:close')
}

export function VoiceHost(): null {
  const cancelledRef = useRef(false)
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceSessionRef = useRef(0)
  // The current recording is dictation (typed by main), not an assistant query.
  const dictationRef = useRef(false)
  const vadRef = useRef<VadConfig | null>(null)
  const extrasRef = useRef<VoiceExtras>(DEFAULT_EXTRAS)
  // A dictation recording is open: its stop sound is still due.
  const stopSoundRef = useRef(false)
  const dictationStoppedRef = useRef(() => {
    if (!stopSoundRef.current) return
    stopSoundRef.current = false
    if (extrasRef.current.sounds) playEarcon('stop')
  })
  // A turn waiting on a confirm in the bar survives the recording that answers it ("yes").
  const confirmWaitRef = useRef<number | null>(null)
  const confirmShownRef = useRef(false)
  const survivorsRef = useRef(new Set<number>())

  // A newer session (or a cancel) took over: the older turn must not act any further.
  const stale = (session: number): boolean =>
    cancelledRef.current ||
    (session !== voiceSessionRef.current && !survivorsRef.current.has(session))

  /** Awaits a main call that may show a confirm; a recording started meanwhile keeps the turn. */
  const mayConfirm = async <T,>(session: number, call: Promise<T>): Promise<T> => {
    confirmWaitRef.current = session
    try {
      return await call
    } finally {
      if (confirmWaitRef.current === session) confirmWaitRef.current = null
    }
  }

  const applyResponse = async (r: QueryResult, session: number): Promise<void> => {
    if (stale(session)) return
    const api = lumen()
    if (r.mode === 'answer') {
      api.send('answer:show', r.text)
    } else if (r.mode === 'action' && r.actions?.length) {
      try {
        const summary =
          (r as { summary?: string }).summary ?? r.actions.map((a) => a.type).join(', ')
        const confidence = (r as { confidence?: string }).confidence
        const { delayMs } = await mayConfirm(
          session,
          api.invoke('assistant:announce', summary, confidence)
        )
        if (stale(session)) return
        if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
        if (stale(session)) return
        await mayConfirm(session, api.invoke('assistant:execute', r.actions))
      } catch (err) {
        console.error('[action] failed:', err)
      }
    } else if (r.mode === 'locate') {
      const desc = r.items?.map((i) => i.description || i.label).join(' · ')
      if (desc) api.send('answer:show', `**Found:** ${desc}`)
    } else if (r.mode === 'text_insert' && r.text) {
      await api.invoke('assistant:execute', [{ type: 'type', text: r.text }])
    } else if ((r.mode as string) === 'open_url' && r.url) {
      await api.invoke('assistant:execute', [{ type: 'open_url', url: r.url }])
    }
  }

  const handleDictation = async (text: string, info?: VoiceResultInfo): Promise<void> => {
    dictationRef.current = false
    const keep = !shouldDropTranscript(text, info?.speechMs)
    try {
      // "" tells main the session ended with nothing to type.
      await lumen().invoke('voice:dictate', keep ? text.trim() : '')
    } catch (err) {
      console.error('[dictation] error:', err)
    } finally {
      setPill(false)
      closeBar()
    }
  }

  const handleResult = async (text: string, info?: VoiceResultInfo): Promise<void> => {
    if (dictationRef.current) {
      await handleDictation(text, info)
      return
    }
    if (shouldDropTranscript(text, info?.speechMs)) {
      if (text.trim())
        console.warn('[voice] dropping likely silence hallucination:', JSON.stringify(text))
      // Say so instead of closing silently; the bar closes like after any voice error.
      showErrorThenClose(NOTHING_HEARD)
      return
    }
    // Main's task queue serializes turns; every valid transcript is sent.
    const session = voiceSessionRef.current
    // Safety net: a turn that stalls this long closes the bar.
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current)
    processingTimerRef.current = setTimeout(() => {
      processingTimerRef.current = null
      if (session !== voiceSessionRef.current) return
      console.warn('[safety] processing timeout, closing the bar')
      closeBar()
    }, PROCESSING_TIMEOUT_MS)
    try {
      const result = (await lumen().invoke('assistant:query', text.trim())) as QueryResult | null
      if (!result || stale(session) || result.cancelled) return
      // Auto-detected dictation: main already typed it.
      if (result.dictated) return
      await applyResponse(result, session)
    } catch (err) {
      console.error('[query] error:', err)
    } finally {
      // A newer session owns the bar and its timers now.
      if (session === voiceSessionRef.current) {
        if (processingTimerRef.current) {
          clearTimeout(processingTimerRef.current)
          processingTimerRef.current = null
        }
        closeBar()
      }
      survivorsRef.current.delete(session)
    }
  }

  const handleError = (message: string): void => {
    console.error('[voice] error:', message)
    stopSoundRef.current = false
    // Also for dictation: main restores ducked media and its recording state on this.
    lumen().send('voice:ended')
    setPill(false)
    if (wakeTimerRef.current) {
      clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = null
    }
    showErrorThenClose(message)
  }

  /** Main shows it in the error row (role=alert) and announces it; the bar closes after. */
  const showErrorThenClose = (message: string): void => {
    lumen().send('assistant:error', message)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null
      closeBar()
    }, 1500)
  }

  const { start, stop, abort, levelRef, listening } = useVoice(handleResult, handleError)

  const handleResultRef = useRef(handleResult)
  useEffect(() => {
    handleResultRef.current = handleResult
  })

  const clearTimers = (): void => {
    for (const ref of [wakeTimerRef, errorTimerRef, processingTimerRef]) {
      if (ref.current) clearTimeout(ref.current)
      ref.current = null
    }
  }
  const clearTimersRef = useRef(clearTimers)

  useEffect(() => {
    return lumen().on('assistant:cancel-request', () => {
      cancelledRef.current = true
      dictationStoppedRef.current()
      dictationRef.current = false
      setPill(false)
      survivorsRef.current.clear()
      voiceSessionRef.current++
      clearTimersRef.current()
      abort()
      // Main aborts any in-flight research / plan / model call.
      lumen().send('assistant:cancel')
      closeBar()
    })
  }, [abort])

  useEffect(
    () =>
      lumen().on('assistant:state', (v) => {
        confirmShownRef.current = !!v.confirm
      }),
    []
  )
  useEffect(() => startSpeaker(), [])
  useEffect(() => startBargeIn(), [])
  useEffect(() => startWakeFeed(), [])
  useEffect(() => startMicDeviceSync(), [])
  useEffect(() => setWakeFeedPaused(listening), [listening])

  const beginSessionRef = useRef<() => number>(() => 0)

  useEffect(() => {
    return lumen().on('assistant:run-query', (text) => {
      // A typed query is a new turn: clear an earlier cancel and any stale session state.
      beginSessionRef.current()
      lumen().send('assistant:show')
      handleResultRef.current(text)
    })
  }, [])

  useEffect(() => {
    let alive = true
    lumen()
      .invoke('settings:get')
      .then((cfg) => {
        const v = readVad(cfg)
        if (!alive) return
        if (v) vadRef.current = v
        extrasRef.current = readExtras(cfg)
      })
      .catch(() => {})
    const unsub = lumen().on('settings:changed', (cfg) => {
      const v = readVad(cfg)
      if (v) vadRef.current = v
      extrasRef.current = readExtras(cfg)
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  useEffect(() => {
    beginSessionRef.current = (): number => {
      clearTimers()
      cancelledRef.current = false
      dictationRef.current = false
      setPill(false)
      stopSoundRef.current = false
      const waiting = confirmWaitRef.current
      if (waiting !== null && confirmShownRef.current) survivorsRef.current.add(waiting)
      return ++voiceSessionRef.current
    }
    clearTimersRef.current = clearTimers
  })

  useEffect(() => {
    /** Speech threshold, lowered in whisper mode. */
    const threshold = (vad: VadConfig): number =>
      extrasRef.current.whisper ? whisperThreshold(vad.speechThreshold) : vad.speechThreshold
    const whisper = (): boolean => extrasRef.current.whisper
    /** The dictation recording is over (key released, tap, silence): the stop sound. */
    const dictationStopped = (): void => dictationStoppedRef.current()
    const startHold = (): void => {
      beginSessionRef.current()
      const vad = vadRef.current ?? DEFAULT_VAD
      start({ speechThreshold: threshold(vad), whisper: whisper() })
    }
    // Auto-stop after sustained silence once speech was heard, give up when nothing is said
    // within maxWaitMs, hard stop at maxRecordMs (also enforced in useVoice).
    const watchSilence = (
      session: number,
      opts: {
        threshold: number
        silenceMs: number
        maxWaitMs: number
        maxRecordMs: number
        onNoSpeech: () => void
        // Speech already started before the recording (barge-in pre-roll).
        heardSpeech?: boolean
      }
    ): void => {
      const startedAt = Date.now()
      const gate = new RmsGate({ threshold: opts.threshold })
      let heardSpeech = opts.heardSpeech ?? false
      let silenceStart = 0
      // The hotkey state in main must know the recording is over, or the next press stops
      // a recording that no longer exists.
      const ended = (): void => {
        dictationStopped()
        lumen().send('voice:ended')
      }
      const tick = (): void => {
        wakeTimerRef.current = null
        if (session !== voiceSessionRef.current || cancelledRef.current) return
        const now = Date.now()
        if (now - startedAt >= opts.maxRecordMs) {
          ended()
          stop()
          return
        }
        if (gate.update(levelRef.current)) {
          heardSpeech = true
          silenceStart = 0
        } else if (heardSpeech) {
          if (silenceStart === 0) silenceStart = now
          else if (now - silenceStart >= opts.silenceMs) {
            ended()
            stop()
            return
          }
        }
        if (!heardSpeech && now - startedAt > opts.maxWaitMs) {
          ended()
          cancelledRef.current = true
          abort()
          opts.onNoSpeech()
          closeBar()
          return
        }
        wakeTimerRef.current = setTimeout(tick, 80)
      }
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = setTimeout(tick, 200)
    }
    const startHandsFree = (): void => {
      const session = beginSessionRef.current()
      const vad = vadRef.current ?? DEFAULT_VAD
      const maxRecordMs = vad.maxRecordMs ?? DEFAULT_MAX_RECORD_MS
      // After a voice barge-in, the words that interrupted the answer lead the recording.
      const preRoll = takePreRoll() ?? undefined
      start({ speechThreshold: threshold(vad), maxRecordMs, preRoll, whisper: whisper() })
      watchSilence(session, {
        threshold: threshold(vad),
        silenceMs: vad.silenceMs,
        maxWaitMs: vad.maxWaitMs,
        maxRecordMs,
        onNoSpeech: () => {},
        heardSpeech: !!preRoll
      })
    }
    // Dictation hotkey: held until release; a double-tap turns it hands-free.
    const startDictation = (): void => {
      beginSessionRef.current()
      dictationRef.current = true
      const extras = extrasRef.current
      if (extras.pill) setPill(true)
      if (extras.sounds) playEarcon('start')
      stopSoundRef.current = true
      const vad = vadRef.current ?? DEFAULT_VAD
      start({
        speechThreshold: threshold(vad),
        maxRecordMs: DICTATION_MAX_RECORD_MS,
        watchdogMs: DICTATION_MAX_RECORD_MS + 5000,
        dictation: true,
        whisper: whisper()
      })
    }
    // A quick tap on the assistant hotkey: keep listening, stop on silence.
    const assistantHandsFree = (): void => {
      const vad = vadRef.current ?? DEFAULT_VAD
      watchSilence(voiceSessionRef.current, {
        threshold: threshold(vad),
        silenceMs: vad.silenceMs,
        maxWaitMs: vad.maxWaitMs,
        maxRecordMs: vad.maxRecordMs ?? DEFAULT_MAX_RECORD_MS,
        onNoSpeech: () => {}
      })
    }
    const dictationHandsFree = (): void => {
      if (!dictationRef.current) return assistantHandsFree()
      const vad = vadRef.current ?? DEFAULT_VAD
      watchSilence(voiceSessionRef.current, {
        threshold: threshold(vad),
        silenceMs: extrasRef.current.dictationSilenceMs,
        maxWaitMs: vad.maxWaitMs,
        maxRecordMs: DICTATION_HANDS_FREE_MAX_MS,
        onNoSpeech: () => {
          dictationRef.current = false
          lumen()
            .invoke('voice:dictate', '')
            .catch(() => {})
        }
      })
    }
    const starters = { hold: startHold, 'hands-free': startHandsFree, dictation: startDictation }
    const offs = [
      lumen().on('voice:start', ({ mode }) => starters[mode]?.()),
      lumen().on('voice:stop', () => {
        dictationStopped()
        void stop()
      }),
      lumen().on('voice:hands-free', dictationHandsFree)
    ]
    return () => offs.forEach((off) => off())
  }, [start, stop, abort, levelRef])

  return null
}
