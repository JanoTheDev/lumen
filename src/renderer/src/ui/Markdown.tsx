// A small, safe Markdown subset: paragraphs, headings, lists, bold, italic, inline code,
// fenced code and links. No raw HTML. Links call onLink and never navigate the window.
// While streaming, each word is its own span keyed by its position, so only new words mount
// (and fade in); the final render lays out the same text, so nothing shifts when it ends.
import { Fragment, type ReactNode } from 'react'
import { parseBlocks } from './md-parse'

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\n]+\*|_[^_\n]+_)/g
const SAFE_URL = /^(https?:|mailto:)/i

const WORD = /\S+/g

/** Plain text, or one span per word while streaming (keys are offsets, so they stay put). */
function words(text: string, at: number, on: boolean): ReactNode {
  if (!on) return text
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(WORD)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span key={at + m.index} className="ui-md__w">
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <Fragment key={`t${at}`}>{out}</Fragment>
}

function renderInline(text: string, onLink?: (url: string) => void, stream = false): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(words(text.slice(last, m.index), last, stream))
    const t = m[0]
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{words(t.slice(2, -2), m.index, stream)}</strong>)
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
    } else out.push(<em key={k++}>{words(t.slice(1, -1), m.index, stream)}</em>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(words(text.slice(last), last, stream))
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
          {b.kind === 'p' && <p>{renderInline(b.text, onLink, streaming)}</p>}
          {b.kind === 'h' && (
            <p className="ui-md__h">
              <strong>{renderInline(b.text, onLink, streaming)}</strong>
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
                  <li key={j}>{renderInline(it, onLink, streaming)}</li>
                ))}
              </ul>
            ) : (
              <ol>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, onLink, streaming)}</li>
                ))}
              </ol>
            ))}
        </Fragment>
      ))}
    </div>
  )
}
