// A small, safe Markdown subset: paragraphs, headings, lists, bold, italic, inline code,
// fenced code and links. No raw HTML. Links call onLink and never navigate the window.
import { Fragment, type ReactNode } from 'react'
import { parseBlocks } from './md-parse'

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\n]+\*|_[^_\n]+_)/g
const SAFE_URL = /^(https?:|mailto:)/i

function renderInline(text: string, onLink?: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>)
    else if (m[3]) {
      const split = t.indexOf('](')
      const label = t.slice(1, split)
      const url = t.slice(split + 2, -1)
      out.push(
        SAFE_URL.test(url) ? (
          <a
            key={k++}
            href={url}
            onClick={(e) => {
              e.preventDefault()
              onLink?.(url)
            }}
          >
            {label}
          </a>
        ) : (
          label
        )
      )
    } else out.push(<em key={k++}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export interface MarkdownProps {
  source: string
  onLink?: (url: string) => void
  streaming?: boolean
  className?: string
}

export function Markdown({ source, onLink, streaming, className }: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(source)
  return (
    <div
      className={['ui-md', className].filter(Boolean).join(' ')}
      aria-busy={streaming || undefined}
    >
      {blocks.map((b, i) => (
        <Fragment key={i}>
          {b.kind === 'p' && <p>{renderInline(b.text, onLink)}</p>}
          {b.kind === 'h' && (
            <p className="ui-md__h">
              <strong>{renderInline(b.text, onLink)}</strong>
            </p>
          )}
          {b.kind === 'code' && (
            <pre>
              <code>{b.text}</code>
            </pre>
          )}
          {(b.kind === 'ul' || b.kind === 'ol') &&
            (b.kind === 'ul' ? (
              <ul>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, onLink)}</li>
                ))}
              </ul>
            ) : (
              <ol>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, onLink)}</li>
                ))}
              </ol>
            ))}
        </Fragment>
      ))}
    </div>
  )
}
