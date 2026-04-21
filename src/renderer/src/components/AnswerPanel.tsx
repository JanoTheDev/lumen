import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface AnswerPanelProps { text: string }

export function AnswerPanel({ text }: AnswerPanelProps): JSX.Element {
  return (
    <div className="px-3 pb-1">
      <div
        className="rounded-2xl px-4 py-3"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.04) 100%)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)',
          borderRadius: '18px'
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="mb-2 last:mb-0 text-[12.5px] text-white/80 leading-relaxed">{children}</p>,
            ul: ({ children }) => <ul className="mb-2 list-disc pl-4 text-[12.5px] text-white/80 space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="mb-2 list-decimal pl-4 text-[12.5px] text-white/80 space-y-0.5">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            code: ({ children, className }) =>
              className
                ? <code className="block rounded-xl bg-white/6 border border-white/8 px-3 py-2 text-[11px] font-mono text-purple-300/90 mt-1 mb-2">{children}</code>
                : <code className="rounded-lg bg-white/8 px-1.5 py-0.5 text-[11px] font-mono text-purple-300/90">{children}</code>,
            strong: ({ children }) => <strong className="font-semibold text-white/95">{children}</strong>,
            h1: ({ children }) => <h1 className="text-sm font-semibold text-white/90 mb-1.5">{children}</h1>,
            h2: ({ children }) => <h2 className="text-[13px] font-semibold text-white/90 mb-1">{children}</h2>,
            h3: ({ children }) => <h3 className="text-[12px] font-medium text-white/85 mb-1">{children}</h3>,
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  )
}
