// Scan keyboard window (06 T10): keys from main (a11y:keyboard-state), word suggestions on the
// top row. Clicks (mouse or dwell) send the key id; the window never takes focus, so the
// typing lands in the app underneath. Switch scanning highlights a row, then a key.
import { useEffect, useState } from 'react'
import type { ScanKeyboardState } from '@shared/channels'
import { invoke, send, useIpc } from '../lib/ipc'

const EMPTY: ScanKeyboardState = {
  rows: [],
  highlight: { row: null, key: null },
  shift: false,
  caps: false
}

export function ScanKeyboard(): JSX.Element {
  const [state, setState] = useState<ScanKeyboardState>(EMPTY)
  useEffect(() => {
    invoke('a11y:keyboard-state')
      .then(setState)
      .catch(() => {})
  }, [])
  useIpc('a11y:keyboard-state', setState)
  const { row: hiRow, key: hiKey } = state.highlight

  return (
    <div className="kb-root" role="group" aria-label="Lumen keyboard">
      <div className="kb-grip" aria-hidden="true" title="Drag to move" />
      {state.rows.map((row, r) => {
        const rowOn = hiRow === r && hiKey === null
        return (
          <div
            key={r}
            className={`kb-row${r === 0 ? ' kb-row--words' : ''}${rowOn ? ' is-scan' : ''}`}
            role={r === 0 ? 'toolbar' : undefined}
            aria-label={r === 0 ? 'Word suggestions' : undefined}
          >
            {r === 0 && !row.length && <span className="kb-hint">Suggestions appear here</span>}
            {row.map((k, i) => {
              const keyOn = hiRow === r && hiKey === i
              return (
                <button
                  key={k.id}
                  type="button"
                  className={`kb-key${k.on ? ' is-on' : ''}${keyOn ? ' is-scan' : ''}`}
                  style={{ flexGrow: k.wide ?? 1 }}
                  aria-label={k.name ?? k.label}
                  aria-pressed={k.id === 'shift' || k.id === 'caps' ? !!k.on : undefined}
                  onClick={() => send('a11y:keyboard-key', k.id)}
                >
                  {k.label}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
