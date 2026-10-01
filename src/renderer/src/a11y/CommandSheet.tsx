// "What can I say" sheet (06 T21). Rows come from main, generated from the grammar table.
// Keyboard: type to search, Tab to the sections, arrows move through commands, Esc closes.
// Big targets so dwell and switch users can jump between sections and close it.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { CommandSheetData } from '@shared/channels'
import { invoke, send, useIpc } from '../lib/ipc'
import { LiveRegion, announce } from '../ui'
import { buildSections, filterRows } from './sheet'

function moveFocus(e: KeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')]
  if (!rows.length) return
  const i = rows.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
  e.preventDefault()
  rows[next].focus()
}

export function CommandSheet(): JSX.Element {
  const [data, setData] = useState<CommandSheetData>({ rows: [], hotkey: '' })
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const fetchRows = (): void => {
    invoke('a11y:commands')
      .then(setData)
      .catch(() => {})
  }
  useEffect(fetchRows, [])
  useIpc('a11y:sheet-refresh', () => {
    fetchRows()
    setQuery('')
    searchRef.current?.focus()
  })

  const sections = useMemo(() => buildSections(filterRows(data.rows, query)), [data, query])
  const count = sections.reduce((n, s) => n + s.rows.length, 0)

  useEffect(() => {
    if (!query) return
    const t = window.setTimeout(
      () => announce(count === 1 ? '1 command' : `${count} commands`),
      400
    )
    return () => window.clearTimeout(t)
  }, [query, count])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') send('a11y:sheet-close')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const jump = (id: string): void => {
    const h = document.getElementById(`sec-${id}`)
    h?.scrollIntoView({ block: 'start' })
    h?.focus()
  }

  return (
    <main className="cs-root" aria-labelledby="cs-title">
      <LiveRegion />
      <header className="cs-head">
        <h1 id="cs-title" className="cs-title">
          What you can say
        </h1>
        <button type="button" className="cs-close" onClick={() => send('a11y:sheet-close')}>
          Close
        </button>
      </header>
      <p className="cs-hint">
        Say any of these after the wake word or while holding the hotkey.
        {data.hotkey ? ` ${data.hotkey} opens this list.` : ''}
      </p>
      <input
        ref={searchRef}
        className="cs-search"
        type="search"
        aria-label="Search commands"
        placeholder="Search commands"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <nav className="cs-jump" aria-label="Sections">
        {sections.map((s) => (
          <button key={s.id} type="button" onClick={() => jump(s.id)}>
            {s.title}
          </button>
        ))}
      </nav>
      <div className="cs-list" onKeyDown={moveFocus}>
        {count === 0 && <p className="cs-empty">No command matches “{query}”.</p>}
        {sections.map((s, si) => (
          <section key={s.id} aria-labelledby={`sec-${s.id}`} className="cs-section">
            <h2 id={`sec-${s.id}`} tabIndex={-1} className="cs-section__title">
              {s.title}
            </h2>
            <ul className="cs-rows">
              {s.rows.map((r, ri) => {
                // One tab stop for the whole list; arrows move between rows.
                const tab = si === 0 && ri === 0 ? 0 : -1
                const later = r.when && !r.now
                return (
                  <li
                    key={`${r.say}|${r.when ?? ''}`}
                    data-row
                    tabIndex={tab}
                    className={`cs-row${later ? ' is-later' : ''}`}
                  >
                    <span className="cs-say">“{r.say}”</span>
                    <span className="cs-does">
                      {r.does}
                      {r.when && <span className="cs-when"> ({r.when})</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
