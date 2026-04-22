import { useEffect, useState } from 'react'

type StatusKind = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'acting' | 'answer' | 'error' | 'step'

interface StatusMsg {
  kind: StatusKind
  text: string
  step?: { index: number; total: number }
}

const KIND_STYLE: Record<StatusKind, { dot: string; accent: string }> = {
  idle:          { dot: 'rgba(255,255,255,0.25)', accent: 'rgba(255,255,255,0.08)' },
  listening:     { dot: '#5b8cff',                accent: 'rgba(91,140,255,0.22)' },
  transcribing:  { dot: '#a78bfa',                accent: 'rgba(167,139,250,0.22)' },
  thinking:      { dot: '#a78bfa',                accent: 'rgba(167,139,250,0.22)' },
  acting:        { dot: '#facc15',                accent: 'rgba(250,204,21,0.22)' },
  step:          { dot: '#38bdf8',                accent: 'rgba(56,189,248,0.22)' },
  answer:        { dot: '#4ade80',                accent: 'rgba(74,222,128,0.22)' },
  error:         { dot: '#f87171',                accent: 'rgba(248,113,113,0.22)' },
}

export function StatusApp(): JSX.Element {
  const [msg, setMsg] = useState<StatusMsg | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const unsubStatus = (window as unknown as {
      api: { onStatus: (cb: (m: StatusMsg) => void) => void }
    }).api.onStatus((m) => {
      setMsg(m)
      setVisible(m.kind !== 'idle')
    })
    const unsubHide = (window as unknown as {
      api: { onStatusHide: (cb: () => void) => void }
    }).api.onStatusHide(() => setVisible(false))
    return () => { /* ipcRenderer listeners persist per window */ void unsubStatus; void unsubHide }
  }, [])

  const style = msg ? KIND_STYLE[msg.kind] : KIND_STYLE.idle
  const pulsing = msg && (msg.kind === 'listening' || msg.kind === 'thinking' || msg.kind === 'transcribing' || msg.kind === 'acting')

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: transparent; width: 100%; height: 100%; overflow: hidden; font-family: -apple-system, "Segoe UI", Inter, sans-serif; }
        @keyframes bubble-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes bubble-out { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(8px); } }
        @keyframes pulse-dot { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
      `}</style>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 6,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            height: 30,
            padding: '0 14px',
            borderRadius: 999,
            background: 'rgba(12, 14, 20, 0.78)',
            backdropFilter: 'blur(24px) saturate(160%)',
            WebkitBackdropFilter: 'blur(24px) saturate(160%)',
            border: `1px solid ${style.accent}`,
            boxShadow: '0 6px 20px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
            color: 'rgba(255,255,255,0.85)',
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: 0.1,
            whiteSpace: 'nowrap',
            maxWidth: '94vw',
            animation: visible ? 'bubble-in 160ms ease-out both' : 'bubble-out 180ms ease-in both',
            opacity: visible ? 1 : 0,
          }}
        >
          <span
            style={{
              width: 7, height: 7, borderRadius: '50%',
              background: style.dot,
              boxShadow: `0 0 8px ${style.dot}`,
              animation: pulsing ? 'pulse-dot 1.1s ease-in-out infinite' : 'none',
            }}
          />
          {msg?.step && (
            <span style={{ color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
              {msg.step.index}/{msg.step.total}
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {msg?.text ?? ''}
          </span>
        </div>
      </div>
    </>
  )
}
