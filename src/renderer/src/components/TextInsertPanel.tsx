import { useState } from 'react'
import { Copy, CheckCheck, FileText } from 'lucide-react'

interface TextInsertPanelProps { text: string; targetHint: string }

export function TextInsertPanel({ text, targetHint }: TextInsertPanelProps): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const insert = async (): Promise<void> => {
    await window.api.executeAction([{ type: 'type', text }])
  }

  return (
    <div className="px-3 pb-1">
      {targetHint && (
        <div className="flex items-center gap-1.5 mb-2 px-1">
          <FileText size={10} className="text-white/30" />
          <span className="text-[10px] text-white/35">{targetHint}</span>
        </div>
      )}

      <div
        className="mb-2.5 rounded-2xl px-4 py-3"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)',
          border: '1px solid rgba(255,255,255,0.11)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
          borderRadius: '16px'
        }}
      >
        <p className="text-[12.5px] text-white/80 leading-relaxed whitespace-pre-wrap">{text}</p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={copy}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl py-2 text-[11.5px] font-medium text-white/60 transition-all hover:text-white/80"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '12px'
          }}
        >
          {copied ? <CheckCheck size={12} className="text-green-400" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          onClick={insert}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl py-2 text-[11.5px] font-semibold text-white transition-all"
          style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.55), rgba(99,102,241,0.45))',
            border: '1px solid rgba(168,85,247,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
            borderRadius: '12px'
          }}
        >
          Insert
        </button>
      </div>
    </div>
  )
}
