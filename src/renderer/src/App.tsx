import { useState, useEffect, useRef } from 'react'
import { useVoice } from './hooks/useVoice'

type ClaudeResponse =
  | { mode: 'answer'; text: string }
  | { mode: 'guide'; steps: { label: string; target_hint: string; bbox?: [number, number, number, number] }[] }
  | { mode: 'action'; actions: Action[]; summary?: string; follow_up?: { query: string; delay_ms: number } }
  | { mode: 'text_insert'; text: string; target_hint: string }
  | { mode: 'locate'; items: Array<{ label: string; bbox: [number, number, number, number]; description?: string }> }

interface Action {
  type: 'move' | 'click' | 'click_bbox' | 'click_element' | 'click_nth_element' | 'type' | 'hotkey' | 'open_url' | 'focus_browser'
  x?: number; y?: number; bbox?: [number, number, number, number]
  button?: string; text?: string; keys?: string[]; url?: string; n?: number
}

export default function App(): JSX.Element {
  const [phase, setPhase] = useState<'listening' | 'processing' | 'error'>('listening')
  const queryFiredRef = useRef(false)
  const cancelledRef = useRef(false)
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.api.onCancelRequest?.(() => {
      cancelledRef.current = true
      queryFiredRef.current = false
      if (processingTimerRef.current) { clearTimeout(processingTimerRef.current); processingTimerRef.current = null }
      // Signal main process to abort any in-flight research/plan/callClaude loop
      ;(window.api as { cancelCurrent?: () => void }).cancelCurrent?.()
      setPhase('listening')
      window.api.closeHUD()
    })
  }, [])

  const applyResponse = async (r: ClaudeResponse & { url?: string; follow_up?: { query: string; delay_ms: number } }, depth = 0, _pendingFollowUp?: { query: string; delay_ms: number }): Promise<void> => {
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
        const execResult = await window.api.executeAction(r.actions) as { done: boolean; reached_bottom?: boolean } | undefined
        if (execResult?.reached_bottom) {
          console.log('[follow_up] reached_bottom — stopping chain')
          return
        }
        if (r.follow_up && depth < 6) {
          const { query, delay_ms } = r.follow_up
          console.log('[follow_up] depth', depth, 'auto-querying in', delay_ms, 'ms:', query)
          await new Promise((res) => setTimeout(res, delay_ms))
          const fuQuery = query.startsWith('The page is loaded') ? query : `The page is loaded. ${query}`
          const fu = await window.api.query(fuQuery, { lowDetail: true })
          await applyResponse(fu as ClaudeResponse & { url?: string }, depth + 1, r.follow_up)
        } else if (r.follow_up) {
          console.warn('[follow_up] depth limit (6) reached, stopping')
        }
      } catch (err) {
        console.error('[action] failed:', err)
      }
    } else if (r.mode === 'guide' && depth > 0) {
      // AI returned guide during follow_up — auto-click the first bbox instead of showing steps
      const firstWithBbox = r.steps?.find(s => s.bbox)
      if (firstWithBbox?.bbox) {
        console.log('[follow_up] guide mode in follow_up — auto-clicking first bbox:', firstWithBbox.bbox)
        await window.api.executeAction([{ type: 'click_bbox', bbox: firstWithBbox.bbox }])
      }
    } else if (r.mode === 'locate') {
      const desc = r.items?.map(i => i.description || i.label).join(' · ')
      if (desc) window.api.showAnswerOverlay?.(`**Found:** ${desc}`)
    } else if (r.mode === 'text_insert' && r.text) {
      await window.api.executeAction([{ type: 'type', text: r.text }])
    } else if ((r.mode as string) === 'open_url' && r.url) {
      await window.api.executeAction([{ type: 'open_url', url: r.url }])
    }
  }

  const handleResult = async (text: string): Promise<void> => {
    console.log('[voice] result:', text)
    if (!text.trim()) {
      window.api.closeHUD()
      setPhase('listening')
      return
    }
    if (text.trim().split(/\s+/).length < 3) {
      console.warn('[voice] transcript too short, skipping API call:', JSON.stringify(text))
      window.api.closeHUD()
      return
    }
    // queryFiredRef blocked queued requests — main-process TaskQueue handles serialization.
    // Fire every valid transcript; queue waits if another query is in flight.
    queryFiredRef.current = true
    setPhase('processing')
    // Safety net: if processing stalls >60s, auto-reset
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current)
    processingTimerRef.current = setTimeout(() => {
      console.warn('[safety] processing timeout — resetting HUD')
      queryFiredRef.current = false
      setPhase('listening')
      window.api.closeHUD()
    }, 60000)
    try {
      console.log('[query] sending:', text)
      const result = await window.api.query(text.trim())
      if (cancelledRef.current) return
      const r = result as ClaudeResponse & { url?: string }
      console.log('[query] response:', JSON.stringify(r))
      await applyResponse(r)
    } catch (err) {
      console.error('[query] error:', err)
    } finally {
      if (processingTimerRef.current) { clearTimeout(processingTimerRef.current); processingTimerRef.current = null }
      window.api.closeHUD()
      setPhase('listening')
    }
  }

  const handleError = (err: unknown): void => {
    console.error('[voice] error, closing HUD:', err)
    setPhase('error')
    setTimeout(() => {
      window.api.closeHUD()
      setPhase('listening')
    }, 1500)
  }

  const { start, stop, audioLevel } = useVoice(handleResult, handleError)

  const audioLevelRef = useRef(0)
  useEffect(() => { audioLevelRef.current = audioLevel }, [audioLevel])

  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__voiceStart = () => {
      console.log('[voice] __voiceStart called')
      queryFiredRef.current = false
      cancelledRef.current = false
      setPhase('listening')
      start()
    }
    ;(window as unknown as Record<string, unknown>).__voiceStop = () => {
      console.log('[voice] __voiceStop called')
      setPhase('processing')
      stop()
    }
    // Wake-word activated recording: auto-stop after sustained silence.
    // Heard speech then ~1.5s quiet → stop. Max 8s total if no speech detected.
    ;(window as unknown as Record<string, unknown>).__wakeVoiceStart = () => {
      console.log('[wake-voice] starting — will auto-stop on silence')
      queryFiredRef.current = false
      cancelledRef.current = false
      setPhase('listening')
      start()
      const startedAt = Date.now()
      const SPEECH_THRESHOLD = 0.04
      const SILENCE_MS = 1500
      const MAX_WAIT_MS = 8000
      let heardSpeech = false
      let silenceStart = 0
      const tick = (): void => {
        if (cancelledRef.current) return
        const now = Date.now()
        const lvl = audioLevelRef.current
        if (lvl > SPEECH_THRESHOLD) {
          heardSpeech = true
          silenceStart = 0
        } else if (heardSpeech) {
          if (silenceStart === 0) silenceStart = now
          else if (now - silenceStart >= SILENCE_MS) {
            console.log('[wake-voice] silence detected — stopping')
            setPhase('processing')
            stop()
            return
          }
        }
        if (!heardSpeech && now - startedAt > MAX_WAIT_MS) {
          console.log('[wake-voice] no speech — cancelling')
          cancelledRef.current = true
          stop()
          window.api.closeHUD()
          setPhase('listening')
          return
        }
        setTimeout(tick, 80)
      }
      setTimeout(tick, 200)
    }
  }, [start, stop])

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

      <div style={{
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
          '0 0 20px color-mix(in srgb, var(--ai-accent, #5b8cff) 18%, transparent)',
        ].join(', '),
        animation: 'pill-in 0.2s cubic-bezier(0.34,1.56,0.64,1) both',
      }}>

        {hasError ? (
          <span style={{ fontSize: 13, color: 'var(--ai-error, #f87171)' }}>⚠</span>
        ) : analyzing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                width: 5, height: 5, borderRadius: '50%',
                background: 'var(--ai-accent, #5b8cff)',
                animation: `dot-bounce 1.2s ease-in-out ${i * 0.18}s infinite`,
              }} />
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 }}>
            {[0.4, 0.7, 1, 0.85, 0.6, 0.45, 0.3].map((shape, i) => {
              const base = 3
              const peak = 16
              const barH = base + (peak - base) * shape * Math.min(audioLevel * 3, 1)
              return (
                <div key={i} style={{
                  width: 2.5,
                  height: Math.max(base, barH),
                  borderRadius: 99,
                  background: 'var(--ai-accent, #5b8cff)',
                  transition: 'height 0.06s ease-out',
                }} />
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
