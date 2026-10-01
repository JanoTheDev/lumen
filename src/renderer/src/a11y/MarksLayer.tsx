// "Show numbers" badges on the screen layer (06 T06). Rects arrive in this display's DIP.
// Badges are black on yellow with a dark outline, sized in rem so they follow a11y.uiScale,
// and sit outside the target's top-left corner so they do not cover its label.
import type { ScreenScene } from '@shared/events'
import type { Rect } from '@shared/types'
import type { CSSProperties } from 'react'
import { badgeSize, placeBadge, type BadgePlace } from './place'

type Marks = NonNullable<ScreenScene['marks']>

const PLACE_STYLE: Record<BadgePlace, (r: Rect) => CSSProperties> = {
  'above-left': (r) => ({ left: r.x, top: r.y, transform: 'translate(-85%, -85%)' }),
  left: (r) => ({ left: r.x, top: r.y, transform: 'translate(-100%, 0)' }),
  above: (r) => ({ left: r.x, top: r.y, transform: 'translate(0, -100%)' }),
  inside: (r) => ({ left: r.x, top: r.y })
}

function rootFontPx(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 16
}

export function MarksLayer({ marks }: { marks: Marks }): JSX.Element {
  const font = rootFontPx()
  const view = { w: window.innerWidth, h: window.innerHeight }
  return (
    <div className="a11y-marks" aria-hidden="true">
      {marks.map((m) => {
        const place = placeBadge(m.rect, badgeSize(m.n, font), view)
        return (
          <span key={m.n} className="a11y-mark" style={PLACE_STYLE[place](m.rect)}>
            {m.n}
          </span>
        )
      })}
    </div>
  )
}
