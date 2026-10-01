// Focus mode on the screen layer (11 T14): dims everything but the kept rects. The layer is
// click-through, so the dimmed parts still work; strong focus names what is behind the dim.
import type { FocusScene } from '@shared/events'
import type { Size } from './geometry'
import { focusPath } from './focusPath'
import './focus.css'

export function FocusMaskSvg({ focus, view }: { focus: FocusScene; view: Size }): JSX.Element {
  return (
    <path
      className={`sl-focus is-${focus.level}`}
      d={focusPath(focus.keep, view)}
      fillRule="evenodd"
    />
  )
}

export function FocusLabels({ focus }: { focus: FocusScene }): JSX.Element | null {
  if (focus.level !== 'strong' || !focus.labels?.length) return null
  return (
    <div className="sl-labels" aria-hidden="true">
      {focus.labels.map((l) => (
        <span
          key={`${l.text}-${l.rect.x}-${l.rect.y}`}
          className="sl-focus-label"
          style={{ left: l.rect.x + l.rect.w / 2, top: l.rect.y + l.rect.h / 2 }}
        >
          {l.text}
        </span>
      ))}
    </div>
  )
}
