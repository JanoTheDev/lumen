import { useState, useEffect, useRef } from 'react'
import type { ModelResponse } from '@shared/types'
import { useVoice, shouldDropTranscript, type VoiceResultInfo } from './hooks/useVoice'

type ClaudeResponse = ModelResponse

interface VadConfig {
  speechThreshold: number
  silenceMs: number
  maxWaitMs: number
  maxRecordMs?: number
}

const DEFAULT_VAD: VadConfig = { speechThreshold: 0.04, silenceMs: 1500, maxWaitMs: 8000 }
const DEFAULT_MAX_RECORD_MS = 30000
const WAVE_SHAPE = [0.4, 0.7, 1, 0.85, 0.6, 0.45, 0.3]
const WAVE_BASE = 3
const WAVE_PEAK = 16
const WAVE_GAIN = 8

function readVad(cfg: unknown): VadConfig | null {
  return (cfg as { vad?: VadConfig } | null)?.vad ?? null
}

export default function App(): JSX.Element {
  const [phase, setPhase] = useState<'listening' | 'processing' | 'error'>('listening')
  const queryFiredRef = useRef(false)
  const cancelledRef = useRef(false)
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceSessionRef = useRef(0)
  const vadRef = useRef<VadConfig | null>(null)
  const barsRef = useRef<Array<HTMLDivElement | null>>([])

  const applyResponse = async (
    r: ClaudeResponse & { url?: string; follow_up?: { query: string; delay_ms: number } },
    depth = 0
  ): Promise<void> => {
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
        if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
        const execResult = (await window.api.executeAction(r.actions)) as
          | { done: boolean; reached_bottom?: boolean }
          | undefined
        if (execResult?.reached_bottom) {
          console.log('[follow_up] reached_bottom — stopping chain')
          return
        }
        if (r.follow_up && depth < 6) {
          const { query, delay_ms } = r.follow_up
          console.log('[follow_up] depth', depth, 'auto-querying in', delay_ms, 'ms:', query)
          await new Promise((res) => setTimeout(res, delay_ms))
          const fuQuery = query.startsWith('The page is loaded')
            ? query
            : `The page is loaded. ${query}`
          const fu = await window.api.query(fuQuery, { lowDetail: true })
          if ((fu as { cancelled?: boolean } | null)?.cancelled) return
          await applyResponse(fu as ClaudeResponse & { url?: string }, depth + 1)
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

  const handleResult = async (text: string, info?: VoiceResultInfo): Promise<void> => {
    console.log('[voice] result:', text)
    if (shouldDropTranscript(text, info?.speechMs)) {
      if (text.trim())
        console.warn('[voice] dropping likely silence hallucination:', JSON.stringify(text))
      resetHud()
      return
    }
    // Main-process TaskQueue handles serialization; fire every valid transcript.
    queryFiredRef.current = true
    setPhase('processing')
    // Safety net: if processing stalls >60s, auto-reset
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current)
    processingTimerRef.current = setTimeout(() => {
      console.warn('[safety] processing timeout — resetting HUD')
      queryFiredRef.current = false
      resetHud()
    }, 60000)
    try {
      console.log('[query] sending:', text)
      const result = await window.api.query(text.trim())
      if (cancelledRef.current || (result as { cancelled?: boolean } | null)?.cancelled) return
      const r = result as ClaudeResponse & { url?: string }
      console.log('[query] response:', JSON.stringify(r))
      await applyResponse(r)
    } catch (err) {
      console.error('[query] error:', err)
    } finally {
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current)
        processingTimerRef.current = null
      }
      resetHud()
    }
  }

  const handleError = (message: string): void => {
    console.error('[voice] error:', message)
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
  useEffect(() => {
    if (!listening || phase !== 'listening') return
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
  }, [listening, phase, levelRef])

  useEffect(() => {
    return window.api.onCancelRequest(() => {
      cancelledRef.current = true
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

  useEffect(() => {
    return window.api.onRunQuery((text) => {
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

  const beginSessionRef = useRef<() => number>(() => 0)
  const resetHudRef = useRef(resetHud)
  useEffect(() => {
    beginSessionRef.current = (): number => {
      clearSessionTimers()
      queryFiredRef.current = false
      cancelledRef.current = false
      setPhase('listening')
      return ++voiceSessionRef.current
    }
    resetHudRef.current = resetHud
  })

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__voiceStart = () => {
      console.log('[voice] __voiceStart called')
      beginSessionRef.current()
      const vad = vadRef.current ?? DEFAULT_VAD
      start({ speechThreshold: vad.speechThreshold })
    }
    w.__voiceStop = () => {
      console.log('[voice] __voiceStop called')
      if (stop()) setPhase('processing')
    }
    // Wake-word / hands-free recording: auto-stop after sustained silence,
    // abort if nothing is said, hard stop at maxRecordMs (enforced in useVoice).
    w.__wakeVoiceStart = () => {
      console.log('[wake-voice] starting — will auto-stop on silence')
      const session = beginSessionRef.current()
      const vad = vadRef.current ?? DEFAULT_VAD
      const maxRecordMs = vad.maxRecordMs ?? DEFAULT_MAX_RECORD_MS
      start({ speechThreshold: vad.speechThreshold, maxRecordMs })
      const startedAt = Date.now()
      let heardSpeech = false
      let silenceStart = 0
      const tick = (): void => {
        wakeTimerRef.current = null
        if (session !== voiceSessionRef.current || cancelledRef.current) return
        const now = Date.now()
        if (now - startedAt >= maxRecordMs) {
          console.log('[wake-voice] max duration reached — stopping')
          setPhase('processing')
          stop()
          return
        }
        if (levelRef.current > vad.speechThreshold) {
          heardSpeech = true
          silenceStart = 0
        } else if (heardSpeech) {
          if (silenceStart === 0) silenceStart = now
          else if (now - silenceStart >= vad.silenceMs) {
            console.log('[wake-voice] silence detected — stopping')
            setPhase('processing')
            stop()
            return
          }
        }
        if (!heardSpeech && now - startedAt > vad.maxWaitMs) {
          console.log('[wake-voice] no speech — aborting')
          cancelledRef.current = true
          abort()
          resetHudRef.current()
          return
        }
        wakeTimerRef.current = setTimeout(tick, 80)
      }
      wakeTimerRef.current = setTimeout(tick, 200)
    }
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
