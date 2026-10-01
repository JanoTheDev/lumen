// Mouse grid on the screen layer (06 T07): a 3×3 grid over `rect` (this display's DIP) with
// semi-transparent cells and large high-contrast numbers that shrink with small cells.
import type { ScreenScene } from '@shared/events'

type Grid = NonNullable<ScreenScene['grid']>

export function GridLayer({ grid }: { grid: Grid }): JSX.Element {
  const { rect, cols, rows } = grid
  const cell = Math.min(rect.w / cols, rect.h / rows)
  // Numbers stay readable on big cells and never overflow small ones.
  const numberPx = Math.max(11, Math.min(cell * 0.55, 56))
  const cells = Array.from({ length: cols * rows }, (_, i) => i + 1)
  return (
    <div
      className="a11y-grid"
      aria-hidden="true"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`
      }}
    >
      {cells.map((n) => (
        <div key={n} className="a11y-grid-cell">
          <span className="a11y-grid-num" style={{ fontSize: numberPx }}>
            {n}
          </span>
        </div>
      ))}
    </div>
  )
}
