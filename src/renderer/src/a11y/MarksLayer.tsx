// "Show numbers" badges on the screen layer (06 T06). Rects arrive in this display's DIP.
// Badges are black on yellow with a dark outline, sized in rem so they follow a11y.uiScale,
// and sit outside the target's top-left corner so they do not cover its label. Overlapping
// badges move aside (screen/marks.ts). They fade/scale in staggered by 8ms, at most 160ms.
import { useLayoutEffect } from 'react'
import type { ScreenScene } from '@shared/events'
import { layoutMarks } from '../screen/marks'

type Marks = NonNullable<ScreenScene['marks']>

const STAGGER_MS = 8
const STAGGER_MAX_MS = 160

function rootFontPx(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 16
}

export function MarksLayer({ marks, exiting }: { marks: Marks; exiting?: boolean }): JSX.Element {
  useLayoutEffect(() => {
    // Render budget check: 300 marks should commit well inside one frame.
    if (typeof performance.measure !== 'function') return
    try {
      const m = performance.measure('screen:marks', 'screen:marks-start')
      if (m.duration > 16)
        console.warn(`[screen] ${marks.length} marks took ${m.duration.toFixed(1)}ms`)
    } catch {
      /* no start mark */
    }
  }, [marks])
  performance.mark?.('screen:marks-start')
  const font = rootFontPx()
  const boxes = layoutMarks(marks, font, { w: window.innerWidth, h: window.innerHeight })
  const step = Math.min(STAGGER_MS, STAGGER_MAX_MS / Math.max(1, marks.length))
  return (
    <div className={`a11y-marks${exiting ? ' is-exit' : ''}`} aria-hidden="true">
      {boxes.map((b, i) => (
        <span
          key={b.n}
          className="a11y-mark"
          style={{ left: b.box.x, top: b.box.y, animationDelay: `${Math.round(i * step)}ms` }}
        >
          {b.n}
        </span>
      ))}
    </div>
  )
}
