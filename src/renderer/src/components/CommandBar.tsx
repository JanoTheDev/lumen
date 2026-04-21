import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useVoice } from '../hooks/useVoice'

interface CommandBarProps {
  onSubmit: (prompt: string) => void
  loading: boolean
  onListeningChange?: (listening: boolean) => void
  onTranscriptChange?: (transcript: string) => void
}

export interface CommandBarHandle {
  start: () => void
  stop: () => void
}

export const CommandBar = forwardRef<CommandBarHandle, CommandBarProps>(function CommandBar({
  onSubmit,
  loading,
  onListeningChange,
  onTranscriptChange
}, ref) {
  const holdRef = useRef(false)

  const handleResult = (text: string): void => {
    if (text.trim()) {
      onSubmit(text.trim())
      onTranscriptChange?.('')
    }
  }

  const { listening, transcript, start, stop, supported } = useVoice(handleResult)

  useImperativeHandle(ref, () => ({ start, stop }), [start, stop])

  useEffect(() => { onListeningChange?.(listening) }, [listening, onListeningChange])
  useEffect(() => { onTranscriptChange?.(transcript) }, [transcript, onTranscriptChange])

  const onMicDown = (): void => {
    if (!supported || loading) return
    holdRef.current = true
    start()
  }

  const onMicUp = (): void => {
    if (!holdRef.current) return
    holdRef.current = false
    stop()
  }

  return (
    <div className="flex items-center justify-center px-4 py-3">
      <button
        onPointerDown={onMicDown}
        onPointerUp={onMicUp}
        onPointerLeave={onMicUp}
        disabled={loading || !supported}
        className="flex select-none items-center gap-2.5 rounded-2xl px-5 py-2.5 text-[12px] font-medium transition-all disabled:opacity-30"
        style={{
          background: listening
            ? 'linear-gradient(135deg, rgba(168,85,247,0.55), rgba(99,102,241,0.45))'
            : 'rgba(255,255,255,0.06)',
          border: listening
            ? '1px solid rgba(168,85,247,0.5)'
            : '1px solid rgba(255,255,255,0.1)',
          boxShadow: listening
            ? 'inset 0 1px 0 rgba(255,255,255,0.2), 0 0 20px rgba(168,85,247,0.35)'
            : 'inset 0 1px 0 rgba(255,255,255,0.08)',
          color: listening ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
          touchAction: 'none',
          userSelect: 'none'
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        {listening ? 'Release to send' : 'Hold to speak'}
      </button>
    </div>
  )
})
