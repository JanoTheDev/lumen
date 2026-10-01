import { useState, useEffect, useRef } from 'react'
import type { ModelResponse } from '@shared/types'
import { useVoice, shouldDropTranscript, type VoiceResultInfo } from './hooks/useVoice'
import { startSpeaker } from './voice/speaker'
import { startBargeIn, takePreRoll } from './voice/barge-in'
import { setWakeFeedPaused, startWakeFeed } from './voice/wake-feed'
import { startMicDeviceSync } from './voice/mic'
import { RmsGate } from './voice/vad/rms'

type ClaudeResponse = ModelResponse

interface VadConfig {
  speechThreshold: number
  silenceMs: number
  maxWaitMs: number
  maxRecordMs?: number
}

const DEFAULT_VAD: VadConfig = { speechThreshold: 0.04, silenceMs: 1500, maxWaitMs: 8000 }
const DEFAULT_MAX_RECORD_MS = 30000
// Dictation: held up to 10 min; hands-free ends after a longer pause than a query.
const DICTATION_MAX_RECORD_MS = 10 * 60_000
const DICTATION_HANDS_FREE_MAX_MS = 3 * 60_000
const DICTATION_SILENCE_MS = 2000
const WAVE_SHAPE = [0.4, 0.7, 1, 0.85, 0.6, 0.45, 0.3]
const WAVE_BASE = 3
const WAVE_PEAK = 16
const WAVE_GAIN = 8

function readVad(cfg: unknown): VadConfig | null {
  return (cfg as { vad?: VadConfig } | null)?.vad ?? null
}

/** `headless`: hosted hidden in the assistant window (ui v2), where the bar draws the UI. */
export default function App({ headless = false }: { headless?: boolean }): JSX.Element {
  const [phase, setPhase] = useState<'listening' | 'processing' | 'error'>('listening')
  const queryFiredRef = useRef(false)
  const cancelledRef = useRef(false)
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceSessionRef = useRef(0)
  // The current recording is dictation (typed by main), not an assistant query.
  const dictationRef = useRef(false)
  const vadRef = useRef<VadConfig | null>(null)
  const barsRef = useRef<Array<HTMLDivElement | null>>([])

  // A newer session (or a cancel) took over: the older turn must not act any further.
  const stale = (session: number): boolean =>
    session !== voiceSessionRef.current || cancelledRef.current

  const applyResponse = async (
    r: ClaudeResponse & { url?: string; follow_up?: { query: string; delay_ms: number } },
    session: number,
    depth = 0
  ): Promise<void> => {
    if (stale(session)) return
    if (r.mode === 'answer' && depth > 0) {
      // AI returned answer in a follow_up chain — means it's done (or confused). Stop chain.
      // System prompt forbids answer mode in follow_up; if it slips through, don't auto-scroll.
      console.log('[follow_up] answer mode at depth', depth, '— stopping chain (AI is done)')
      return
    } else if (r.mode === 'answer') {
      window.api.showAnswerOverlay?.(r.text)
    } else if (r.mode === 'action' && r.actions?.length) {
      console.log('[action] executing', r.actions.length, 'actions')
      try {
        const summary =
          (r as { summary?: string }).summary ?? r.actions.map((a) => a.type).join(', ')
        const confidence = (r as { confidence?: string }).confidence
        const { delayMs } = await window.api.announceAction(summary, confidence)
        if (stale(session)) return
        if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
        if (stale(session)) return
        const execResult = (await window.api.executeAction(r.actions)) as
          | { done: boolean; reached_bottom?: boolean }
          | undefined
        if (stale(session)) return
        if (execResult?.reached_bottom) {
          console.log('[follow_up] reached_bottom — stopping chain')
          return
        }
        if (r.follow_up && depth < 6) {
          const { query, delay_ms } = r.follow_up
          console.log('[follow_up] depth', depth, 'auto-querying in', delay_ms, 'ms:', query)
          await new Promise((res) => setTimeout(res, delay_ms))
          if (stale(session)) return
          const fuQuery = query.startsWith('The page is loaded')
            ? query
            : `The page is loaded. ${query}`
          const fu = await window.api.query(fuQuery, { lowDetail: true })
          if ((fu as { cancelled?: boolean } | null)?.cancelled) return
          await applyResponse(fu as ClaudeResponse & { url?: string }, session, depth + 1)
        } else if (r.follow_up) {
          console.warn('[follow_up] depth limit (6) reached, stopping')
        }
      } catch (err) {
        console.error('[action] failed:', err)
      }
    } else if (r.mode === 'guide' && depth > 0) {
      // AI returned guide during follow_up — auto-click the first target instead of showing steps
      const first = r.steps?.find((s) => s.target || s.bbox)
      if (first?.target) {
        console.log(
          '[follow_up] guide mode in follow_up — auto-clicking first target:',
          first.target
        )
        await window.api.executeAction([{ type: 'click_target', target: first.target }])
      } else if (first?.bbox) {
        console.log('[follow_up] guide mode in follow_up — auto-clicking first bbox:', first.bbox)
        await window.api.executeAction([{ type: 'click_bbox', bbox: first.bbox }])
      }
    } else if (r.mode === 'locate') {
      const desc = r.items?.map((i) => i.description || i.label).join(' · ')
      if (desc) window.api.showAnswerOverlay?.(`**Found:** ${desc}`)
    } else if (r.mode === 'text_insert' && r.text) {
      await window.api.executeAction([{ type: 'type', text: r.text }])
    } else if ((r.mode as string) === 'open_url' && r.url) {
      await window.api.executeAction([{ type: 'open_url', url: r.url }])
    }
  }

  const resetHud = (): void => {
    window.api.closeHUD()
    setPhase('listening')
  }

  const handleDictation = async (text: string, info?: VoiceResultInfo): Promise<void> => {
    dictationRef.current = false
    const keep = !shouldDropTranscript(text, info?.speechMs)
    if (keep) setPhase('processing')
    try {
      // "" tells main the session ended with nothing to type.
      await window.api.dictate(keep ? text.trim() : '')
    } catch (err) {
      console.error('[dictation] error:', err)
    } finally {
      resetHud()
    }
  }

  const handleResult = async (text: string, info?: VoiceResultInfo): Promise<void> => {
    console.log('[voice] result:', text)
    if (dictationRef.current) {
      await handleDictation(text, info)
      return
    }
    if (shouldDropTranscript(text, info?.speechMs)) {
      if (text.trim())
        console.warn('[voice] dropping likely silence hallucination:', JSON.stringify(text))
      resetHud()
      return
    }
    // Main-process TaskQueue handles serialization; fire every valid transcript.
    const session = voiceSessionRef.current
    queryFiredRef.current = true
    setPhase('processing')
    // Safety net: if processing stalls >60s, auto-reset
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current)
    processingTimerRef.current = setTimeout(() => {
      processingTimerRef.current = null
      if (session !== voiceSessionRef.current) return
      console.warn('[safety] processing timeout — resetting HUD')
      queryFiredRef.current = false
      resetHud()
    }, 60000)
    try {
      console.log('[query] sending:', text)
      const result = await window.api.query(text.trim())
      if (stale(session) || (result as { cancelled?: boolean } | null)?.cancelled) return
      // Auto-detected dictation: main already typed it.
      if ((result as { dictated?: boolean } | null)?.dictated) return
      const r = result as ClaudeResponse & { url?: string }
      console.log('[query] response:', JSON.stringify(r))
      await applyResponse(r, session)
    } catch (err) {
      console.error('[query] error:', err)
    } finally {
      // A newer session owns the HUD and its timers now.
      if (session === voiceSessionRef.current && processingTimerRef.current) {
        clearTimeout(processingTimerRef.current)
        processingTimerRef.current = null
      }
      if (session === voiceSessionRef.current) resetHud()
    }
  }

  const handleError = (message: string): void => {
    console.error('[voice] error:', message)
    if (!dictationRef.current) window.lumen.send('voice:ended')
    if (wakeTimerRef.current) {
      clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = null
    }
    setPhase('error')
    window.api.showAnswerOverlay?.(message)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null
      resetHud()
    }, 1500)
  }

  const { start, stop, abort, levelRef, listening } = useVoice(handleResult, handleError)

  const handleResultRef = useRef(handleResult)
  useEffect(() => {
    handleResultRef.current = handleResult
  })

  const clearSessionTimers = (): void => {
    if (wakeTimerRef.current) {
      clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = null
    }
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current)
      errorTimerRef.current = null
    }
  }

  // Push the input level straight to the waveform bars instead of re-rendering per frame.
  // Headless, the bars are hidden; the bar's LevelMeter reads --voice-level instead.
  useEffect(() => {
    if (headless || !listening || phase !== 'listening') return
    const bars = barsRef.current
    let raf = 0
    const draw = (): void => {
      const lvl = Math.min(levelRef.current * WAVE_GAIN, 1)
      bars.forEach((bar, i) => {
        if (!bar) return
        const h = WAVE_BASE + (WAVE_PEAK - WAVE_BASE) * WAVE_SHAPE[i] * lvl
        bar.style.height = `${Math.max(WAVE_BASE, h)}px`
      })
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      bars.forEach((bar) => {
        if (bar) bar.style.height = `${WAVE_BASE}px`
      })
    }
  }, [headless, listening, phase, levelRef])

  useEffect(() => {
    return window.api.onCancelRequest(() => {
      cancelledRef.current = true
      dictationRef.current = false
      queryFiredRef.current = false
      voiceSessionRef.current++
      if (wakeTimerRef.current) {
        clearTimeout(wakeTimerRef.current)
        wakeTimerRef.current = null
      }
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current)
        errorTimerRef.current = null
      }
      abort()
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current)
        processingTimerRef.current = null
      }
      // Signal main process to abort any in-flight research/plan/callClaude loop
      window.api.cancelCurrent()
      setPhase('listening')
      window.api.closeHUD()
    })
  }, [abort])

  useEffect(() => startSpeaker(), [])
  useEffect(() => startBargeIn(), [])
  useEffect(() => startWakeFeed(), [])
  useEffect(() => startMicDeviceSync(), [])
  useEffect(() => setWakeFeedPaused(listening), [listening])

  const beginSessionRef = useRef<() => number>(() => 0)
  const resetHudRef = useRef(resetHud)

  useEffect(() => {
    return window.api.onRunQuery((text) => {
      // A typed query is a new turn: clear an earlier cancel and any stale session state.
      beginSessionRef.current()
      window.api.showHUD()
      handleResultRef.current(text)
    })
  }, [])

  useEffect(() => {
    let alive = true
    window.api
      .getConfig()
      .then((cfg) => {
        const v = readVad(cfg)
        if (alive && v) vadRef.current = v
      })
      .catch(() => {})
    const unsub = window.api.onConfigChanged((cfg) => {
      const v = readVad(cfg)
      if (v) vadRef.current = v
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  useEffect(() => {
    beginSessionRef.current = (): number => {
      clearSessionTimers()
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current)
        processingTimerRef.current = null
      }
      queryFiredRef.current = false
      cancelledRef.current = false
      dictationRef.current = false
      setPhase('listening')
      return ++voiceSessionRef.current
    }
    resetHudRef.current = resetHud
  })

  useEffect(() => {
    const startHold = (): void => {
      console.log('[voice] start (hold)')
      beginSessionRef.current()
      const vad = vadRef.current ?? DEFAULT_VAD
      start({ speechThreshold: vad.speechThreshold })
    }
    const stopRecording = (): void => {
      console.log('[voice] stop')
      if (stop()) setPhase('processing')
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
        if (!dictationRef.current) window.lumen.send('voice:ended')
      }
      const tick = (): void => {
        wakeTimerRef.current = null
        if (session !== voiceSessionRef.current || cancelledRef.current) return
        const now = Date.now()
        if (now - startedAt >= opts.maxRecordMs) {
          console.log('[auto-stop] max duration reached — stopping')
          ended()
          setPhase('processing')
          stop()
          return
        }
        if (gate.update(levelRef.current)) {
          heardSpeech = true
          silenceStart = 0
        } else if (heardSpeech) {
          if (silenceStart === 0) silenceStart = now
          else if (now - silenceStart >= opts.silenceMs) {
            console.log('[auto-stop] silence detected — stopping')
            ended()
            setPhase('processing')
            stop()
            return
          }
        }
        if (!heardSpeech && now - startedAt > opts.maxWaitMs) {
          console.log('[auto-stop] no speech — aborting')
          ended()
          cancelledRef.current = true
          abort()
          opts.onNoSpeech()
          resetHudRef.current()
          return
        }
        wakeTimerRef.current = setTimeout(tick, 80)
      }
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = setTimeout(tick, 200)
    }
    const startHandsFree = (): void => {
      console.log('[wake-voice] starting — will auto-stop on silence')
      const session = beginSessionRef.current()
      const vad = vadRef.current ?? DEFAULT_VAD
      const maxRecordMs = vad.maxRecordMs ?? DEFAULT_MAX_RECORD_MS
      // After a voice barge-in, the words that interrupted the answer lead the recording.
      const preRoll = takePreRoll() ?? undefined
      start({ speechThreshold: vad.speechThreshold, maxRecordMs, preRoll })
      watchSilence(session, {
        threshold: vad.speechThreshold,
        silenceMs: vad.silenceMs,
        maxWaitMs: vad.maxWaitMs,
        maxRecordMs,
        onNoSpeech: () => {},
        heardSpeech: !!preRoll
      })
    }
    // Dictation hotkey: held until release; a double-tap turns it hands-free.
    const startDictation = (): void => {
      console.log('[dictation] starting')
      beginSessionRef.current()
      dictationRef.current = true
      const vad = vadRef.current ?? DEFAULT_VAD
      start({
        speechThreshold: vad.speechThreshold,
        maxRecordMs: DICTATION_MAX_RECORD_MS,
        watchdogMs: DICTATION_MAX_RECORD_MS + 5000,
        dictation: true
      })
    }
    // A quick tap on the assistant hotkey: keep listening, stop on silence.
    const assistantHandsFree = (): void => {
      console.log('[voice] hands-free — will auto-stop on silence')
      const vad = vadRef.current ?? DEFAULT_VAD
      watchSilence(voiceSessionRef.current, {
        threshold: vad.speechThreshold,
        silenceMs: vad.silenceMs,
        maxWaitMs: vad.maxWaitMs,
        maxRecordMs: vad.maxRecordMs ?? DEFAULT_MAX_RECORD_MS,
        onNoSpeech: () => {}
      })
    }
    const dictationHandsFree = (): void => {
      if (!dictationRef.current) return assistantHandsFree()
      console.log('[dictation] hands-free — will auto-stop on silence')
      const vad = vadRef.current ?? DEFAULT_VAD
      watchSilence(voiceSessionRef.current, {
        threshold: vad.speechThreshold,
        silenceMs: Math.max(vad.silenceMs, DICTATION_SILENCE_MS),
        maxWaitMs: vad.maxWaitMs,
        maxRecordMs: DICTATION_HANDS_FREE_MAX_MS,
        onNoSpeech: () => {
          dictationRef.current = false
          window.api.dictate('').catch(() => {})
        }
      })
    }
    const starters = { hold: startHold, 'hands-free': startHandsFree, dictation: startDictation }
    const offs = [
      window.lumen.on('voice:start', ({ mode }) => starters[mode]?.()),
      window.lumen.on('voice:stop', stopRecording),
      window.lumen.on('voice:hands-free', dictationHandsFree)
    ]
    return () => offs.forEach((off) => off())
  }, [start, stop, abort, levelRef])

  const analyzing = phase === 'processing'
  const hasError = phase === 'error'

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: transparent; width: 100%; height: 100%; overflow: hidden; }

        @keyframes pill-in {
          from { opacity: 0; transform: translateY(6px) scale(0.94); }
          to   { opacity: 1; transform: translateY(0)   scale(1); }
        }
        @keyframes dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.3; }
          40%            { transform: translateY(-4px); opacity: 0.85; }
        }
      `}</style>

      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          background: 'color-mix(in srgb, var(--ai-background, #0d0f14) 88%, transparent)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          border: '1px solid color-mix(in srgb, var(--ai-accent, #5b8cff) 40%, transparent)',
          boxShadow: [
            '0 8px 32px rgba(0,0,0,0.38)',
            '0 2px 6px rgba(0,0,0,0.22)',
            'inset 0 1px 0 color-mix(in srgb, var(--ai-foreground, #fff) 14%, transparent)',
            '0 0 20px color-mix(in srgb, var(--ai-accent, #5b8cff) 18%, transparent)'
          ].join(', '),
          animation: 'pill-in 0.2s cubic-bezier(0.34,1.56,0.64,1) both'
        }}
      >
        {hasError ? (
          <span style={{ fontSize: 13, color: 'var(--ai-error, #f87171)' }}>⚠</span>
        ) : analyzing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: 'var(--ai-accent, #5b8cff)',
                  animation: `dot-bounce 1.2s ease-in-out ${i * 0.18}s infinite`
                }}
              />
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 }}>
            {WAVE_SHAPE.map((_shape, i) => (
              <div
                key={i}
                ref={(el) => {
                  barsRef.current[i] = el
                }}
                style={{
                  width: 2.5,
                  height: WAVE_BASE,
                  borderRadius: 99,
                  background: 'var(--ai-accent, #5b8cff)',
                  transition: 'height 0.06s ease-out'
                }}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
