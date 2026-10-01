// Dwell click-type palette (06 T08): a narrow always-on-top dock. Dwelling on a button (main
// turns that dwell into a plain click here) picks what the next dwell does. The grip at the
// top moves the dock.
import { useEffect, useState } from 'react'
import type { DwellPaletteButton, DwellPaletteState } from '@shared/channels'
import { invoke, send, useIpc } from '../lib/ipc'

type PaletteButton = DwellPaletteButton | 'keyboard'

const BUTTONS: { id: PaletteButton; label: string; glyph: string }[] = [
  { id: 'left', label: 'Left click', glyph: 'L' },
  { id: 'right', label: 'Right click', glyph: 'R' },
  { id: 'double', label: 'Double click', glyph: '2×' },
  { id: 'drag', label: 'Drag', glyph: '⤡' },
  { id: 'scroll', label: 'Scroll', glyph: '↕' },
  { id: 'keyboard', label: 'Keyboard', glyph: '⌨' },
  { id: 'pause', label: 'Pause dwell', glyph: '❚❚' }
]

const INITIAL: DwellPaletteState = {
  enabled: false,
  next: 'left',
  sticky: false,
  paused: false,
  dragging: false,
  scrolling: false
}

function pressed(state: DwellPaletteState, id: PaletteButton): boolean | undefined {
  if (id === 'keyboard') return undefined
  return id === 'pause' ? state.paused : !state.paused && state.next === id
}

function statusText(s: DwellPaletteState): string {
  if (s.paused) return 'Paused'
  if (s.dragging) return 'Dwell where to drop'
  if (s.scrolling) return 'Dwell on an arrow'
  return BUTTONS.find((b) => b.id === s.next)?.label ?? ''
}

export function DwellPalette(): JSX.Element {
  const [state, setState] = useState<DwellPaletteState>(INITIAL)
  useEffect(() => {
    invoke('a11y:dwell-state')
      .then(setState)
      .catch(() => {})
  }, [])
  useIpc('a11y:dwell-state', setState)

  return (
    <div
      className={`dp-root${state.paused ? ' is-paused' : ''}`}
      role="toolbar"
      aria-label="Dwell click type"
      aria-orientation="vertical"
    >
      <div className="dp-grip" aria-hidden="true" title="Drag to move" />
      {BUTTONS.map((b) => {
        const on = pressed(state, b.id)
        return (
          <button
            key={b.id}
            type="button"
            className={`dp-btn${on ? ' is-on' : ''}`}
            aria-pressed={on}
            aria-label={b.id === 'pause' && state.paused ? 'Resume dwell' : b.label}
            title={b.id === 'pause' && state.paused ? 'Resume dwell' : b.label}
            onClick={() => send('a11y:dwell-pick', b.id)}
          >
            <span className="dp-glyph" aria-hidden="true">
              {b.id === 'pause' && state.paused ? '▶' : b.glyph}
            </span>
          </button>
        )
      })}
      <p className="dp-status" aria-live="polite">
        {statusText(state)}
      </p>
    </div>
  )
}
