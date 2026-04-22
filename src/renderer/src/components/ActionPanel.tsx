import { useState } from 'react'
import { Zap, Play, CheckCircle2, XCircle } from 'lucide-react'

interface Action { type: string; x?: number; y?: number; button?: string; text?: string; keys?: string[]; url?: string }
interface ActionPanelProps { actions: Action[]; summary?: string }
type Status = 'idle' | 'running' | 'done' | 'cancelled'

function describeAction(a: Action): string {
  if (a.type === 'open_url') return `Open ${a.url}`
  if (a.type === 'move') return `Move to (${a.x}, ${a.y})`
  if (a.type === 'click') return `Click at (${a.x}, ${a.y})`
  if (a.type === 'type') return `Type: "${(a.text ?? '').slice(0, 36)}${(a.text?.length ?? 0) > 36 ? '…' : ''}"`
  if (a.type === 'hotkey') return `Hotkey: ${a.keys?.join(' + ')}`
  return a.type
}

export function ActionPanel({ actions, summary }: ActionPanelProps): JSX.Element {
  const [status, setStatus] = useState<Status>('idle')

  const execute = async (): Promise<void> => {
    setStatus('running')
    const result = await window.api.executeAction(actions) as { cancelled?: boolean } | undefined
    setStatus(result?.cancelled ? 'cancelled' : 'done')
  }

  return (
    <div className="px-3 pb-1">
      {summary && <p className="mb-2 px-1 text-[12px] text-white/70 leading-relaxed">{summary}</p>}

      <div
        className="mb-2 rounded-2xl px-3 py-2.5 space-y-1"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '14px'
        }}
      >
        {actions.map((a, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-[10px] text-white/20 w-4 text-right shrink-0">{i + 1}</span>
            <Zap size={9} className="text-purple-400/40 shrink-0" />
            <span className="text-[11px] text-white/55">{describeAction(a)}</span>
          </div>
        ))}
      </div>

      {status === 'idle' && (
        <button
          onClick={execute}
          className="flex w-full items-center justify-center gap-2 rounded-2xl py-2 text-[12px] font-semibold text-white transition-all"
          style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.55), rgba(99,102,241,0.45))',
            border: '1px solid rgba(168,85,247,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2), 0 4px 16px rgba(168,85,247,0.25)',
            borderRadius: '14px'
          }}
        >
          <Play size={12} /> Execute
        </button>
      )}

      {status === 'running' && (
        <div className="flex items-center justify-center gap-2 rounded-2xl py-2 text-[12px] text-purple-300/70"
          style={{ border: '1px solid rgba(168,85,247,0.2)', borderRadius: '14px' }}>
          <div className="h-3 w-3 animate-spin rounded-full border border-purple-400/60 border-t-transparent" />
          Executing…
        </div>
      )}

      {status === 'done' && (
        <div className="flex items-center justify-center gap-2 rounded-2xl py-2 text-[12px] text-green-400/70"
          style={{ border: '1px solid rgba(74,222,128,0.2)', borderRadius: '14px' }}>
          <CheckCircle2 size={13} /> Done
        </div>
      )}

      {status === 'cancelled' && (
        <div className="flex items-center justify-center gap-2 rounded-2xl py-2 text-[12px] text-white/30"
          style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px' }}>
          <XCircle size={13} /> Cancelled
        </div>
      )}
    </div>
  )
}
