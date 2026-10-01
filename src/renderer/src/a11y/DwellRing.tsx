// Dwell ring on the screen layer (06 T08). Solid dark track with a light outline so it reads
// on any background, a progress arc (a filling pie under reduced motion), the click type in
// the middle, and a box around the snapped control. Grey and a pause glyph while paused.
// Also draws the dwell scroll arrows and the drag start marker from the scene.
import { useLayoutEffect, useRef, useState } from 'react'
import type { DwellRingData } from '@shared/channels'
import type { ScreenScene } from '@shared/events'
import { useIpc } from '../lib/ipc'
import { prefersReducedMotion } from '../ui/motion'
import { addSample, displayed, initialInterp, type DwellInterp } from '../screen/dwell-interp'

const GLYPH: Record<string, string> = {
  left: 'L',
  right: 'R',
  double: '2×',
  drag: '⤡',
  drop: '⤓',
  scroll: '↕',
  pause: '❚❚'
}

/** Scroll arrow geometry; matches SCROLL_REACH_PX / SCROLL_BOX_PX in main/a11y/dwell.ts. */
const REACH = 72
const BOX = 56

/** SVG path of a pie slice from 12 o'clock, `p` of a full turn. */
function piePath(cx: number, cy: number, r: number, p: number): string {
  const t = Math.max(0, Math.min(1, p))
  if (t >= 0.999)
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`
  const a = t * 2 * Math.PI - Math.PI / 2
  const x = cx + r * Math.cos(a)
  const y = cy + r * Math.sin(a)
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${t > 0.5 ? 1 : 0} 1 ${x} ${y} Z`
}

/**
 * Smooths the arc between ~25 Hz samples by writing stroke-dashoffset per frame (no React
 * render per frame). Drops retract over 120ms.
 */
function useSmoothArc(
  progress: number,
  active: boolean,
  circ: number
): React.RefObject<SVGCircleElement | null> {
  const arc = useRef<SVGCircleElement>(null)
  const state = useRef<DwellInterp>(initialInterp())
  const shown = useRef(0)
  // Layout effect: the first value lands before paint, so the arc never flashes full.
  useLayoutEffect(() => {
    if (!active) {
      state.current = initialInterp()
      shown.current = 0
      return
    }
    const now = performance.now()
    state.current = addSample(state.current, progress, now, shown.current)
    let raf = 0
    const tick = (): void => {
      raf = 0
      const t = performance.now()
      const v = displayed(state.current, t)
      shown.current = v
      arc.current?.setAttribute('stroke-dashoffset', String(circ * (1 - v)))
      // Keep going while extrapolating (until the next sample) or retracting.
      if (t - state.current.t < 160) raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [progress, active, circ])
  return arc
}

export function DwellRing(): JSX.Element | null {
  const [ring, setRing] = useState<DwellRingData | null>(null)
  useIpc('screen:dwell', setRing)
  const size0 = ring?.size ?? 48
  const circ0 = 2 * Math.PI * (size0 / 2 - 4)
  const arcRef = useSmoothArc(ring?.progress ?? 0, !!ring?.active, circ0)

  if (!ring || !ring.active) return null
  // Read per frame: the ring updates ~25 times a second, so a setting change shows at once.
  const reduced = prefersReducedMotion()
  const size = ring.size ?? 48
  const r = size / 2 - 4
  const c = size / 2
  const circ = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, ring.progress))
  const glyph = ring.paused ? GLYPH.pause : (GLYPH[ring.clickType ?? 'left'] ?? '')
  const cls = `a11y-dwell${ring.paused ? ' is-paused' : ''}${ring.warn ? ' is-warn' : ''}`
  return (
    <>
      {ring.target && (
        <div
          className={`a11y-dwell-target${ring.warn ? ' is-warn' : ''}`}
          style={{
            left: ring.target.x - 3,
            top: ring.target.y - 3,
            width: ring.target.w + 6,
            height: ring.target.h + 6
          }}
        />
      )}
      <svg
        className={cls}
        width={size}
        height={size}
        style={{ left: ring.x - c, top: ring.y - c }}
        aria-hidden="true"
      >
        <circle className="a11y-dwell__outline" cx={c} cy={c} r={r + 2} />
        <circle className="a11y-dwell__track" cx={c} cy={c} r={r} />
        {reduced ? (
          <path className="a11y-dwell__pie" d={piePath(c, c, r - 3, p)} />
        ) : (
          <circle
            ref={arcRef}
            className="a11y-dwell__arc"
            cx={c}
            cy={c}
            r={r}
            strokeDasharray={circ}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
        <text
          className="a11y-dwell__glyph"
          x={c}
          y={c}
          fontSize={Math.max(10, size * 0.32)}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {glyph}
        </text>
      </svg>
    </>
  )
}

export function DwellUi({ ui }: { ui: NonNullable<ScreenScene['dwellUi']> }): JSX.Element {
  const arrows: [string, number, number, string][] = ui.scrollAt
    ? [
        ['up', 0, -1, '↑'],
        ['down', 0, 1, '↓'],
        ['left', -1, 0, '←'],
        ['right', 1, 0, '→']
      ]
    : []
  return (
    <div className="a11y-dwell-ui" aria-hidden="true">
      {ui.scrollAt &&
        arrows.map(([id, dx, dy, ch]) => (
          <span
            key={id}
            className="a11y-dwell-arrow"
            style={{
              left: ui.scrollAt!.x + dx * REACH - BOX / 2,
              top: ui.scrollAt!.y + dy * REACH - BOX / 2,
              width: BOX,
              height: BOX
            }}
          >
            {ch}
          </span>
        ))}
      {ui.dragFrom && (
        <span
          className="a11y-dwell-dragfrom"
          style={{ left: ui.dragFrom.x - 10, top: ui.dragFrom.y - 10 }}
        />
      )}
    </div>
  )
}
