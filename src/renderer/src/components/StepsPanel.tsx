import { useState } from 'react'
import { CheckCircle2, Circle, Eye, EyeOff } from 'lucide-react'

interface Step { label: string; target_hint: string; bbox?: [number, number, number, number] }
interface StepsPanelProps { steps: Step[] }

export function StepsPanel({ steps }: StepsPanelProps): JSX.Element {
  const [completed, setCompleted] = useState<Set<number>>(new Set())
  const [highlightsOn, setHighlightsOn] = useState(true)
  const hasHighlights = steps.some((s) => s.bbox)

  const toggle = (i: number): void =>
    setCompleted((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })

  const toggleHighlights = (): void => {
    if (highlightsOn) window.api.hideHighlights()
    setHighlightsOn((v) => !v)
  }

  return (
    <div className="px-3 pb-1">
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-[10px] text-white/35 font-medium uppercase tracking-wider">
          {completed.size}/{steps.length} steps
        </span>
        {hasHighlights && (
          <button onClick={toggleHighlights} className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors">
            {highlightsOn ? <EyeOff size={10} /> : <Eye size={10} />}
            {highlightsOn ? 'hide' : 'show'} highlights
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {steps.map((step, i) => (
          <div
            key={i}
            onClick={() => toggle(i)}
            className="flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-2.5 transition-all"
            style={{
              background: completed.has(i)
                ? 'rgba(255,255,255,0.03)'
                : 'linear-gradient(135deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.03) 100%)',
              border: '1px solid rgba(255,255,255,0.08)',
              opacity: completed.has(i) ? 0.45 : 1,
              borderRadius: '14px'
            }}
          >
            <span className="mt-0.5 shrink-0">
              {completed.has(i)
                ? <CheckCircle2 size={14} className="text-green-400/70" />
                : <Circle size={14} className="text-purple-400/60" />
              }
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-white/80 leading-snug"
                style={{ textDecoration: completed.has(i) ? 'line-through' : 'none' }}>
                {step.label}
              </p>
              {step.target_hint && (
                <p className="mt-0.5 text-[10.5px] text-white/35">{step.target_hint}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
