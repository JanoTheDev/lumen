// Annotations and user-drawing capture (surfaces.md §3.8, T14). Shapes draw on one after
// another (300ms each, stroke dash); under reduced motion they appear at once. Every stroke
// has a dark halo under a light one under the accent, so it reads on white and on black.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScreenScene } from '@shared/events'
import type { Point } from '@shared/types'
import { send, useIpc } from '../lib/ipc'
import { outlinePath, shapeFor } from './annotate'
import { getStroke } from 'perfect-freehand'

type Annotation = NonNullable<ScreenScene['annotations']>[number]

const DRAW_MS = 300
const CAPTURE_TIMEOUT_MS = 30_000

function Shape({ a, index }: { a: Annotation; index: number }): JSX.Element | null {
  const shape = useMemo(() => shapeFor(a.kind, a.points), [a.kind, a.points])
  const delay = { animationDelay: `${index * DRAW_MS}ms` }
  if (a.kind === 'text') return null
  if (shape.fill)
    return (
      <g className="sl-ann sl-ann--fill" style={delay}>
        <path className="sl-ann__halo" d={shape.fill} />
        <path className="sl-ann__ink" d={shape.fill} />
      </g>
    )
  return (
    <g className="sl-ann">
      {shape.strokes.map((d, i) => (
        <g key={i}>
          <path className="sl-ann__halo" d={d} pathLength={1} style={delay} />
          <path className="sl-ann__light" d={d} pathLength={1} style={delay} />
          <path className="sl-ann__ink" d={d} pathLength={1} style={delay} />
        </g>
      ))}
    </g>
  )
}

export function AnnotationsSvg({ list }: { list: Annotation[] }): JSX.Element {
  return (
    <>
      {list.map((a, i) => (
        <Shape key={`${a.kind}${i}`} a={a} index={i} />
      ))}
    </>
  )
}

export function AnnotationTexts({ list }: { list: Annotation[] }): JSX.Element {
  return (
    <div className="sl-labels" aria-hidden="true">
      {list.map((a, i) =>
        a.kind === 'text' && a.text && a.points[0] ? (
          <div
            key={`t${i}`}
            className="sl-pill sl-ann-text"
            style={{
              transform: `translate(${a.points[0].x}px, ${a.points[0].y}px)`,
              animationDelay: `${i * DRAW_MS}ms`
            }}
          >
            <span>{a.text}</span>
          </div>
        ) : null
      )}
    </div>
  )
}

function bbox(points: Point[]): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/**
 * Capture mode: while main has made this layer clickable, the user draws one stroke. On
 * release it goes to main as `screen:user-drawing`; Escape or 30s of nothing ends capture.
 */
export function CaptureLayer(): JSX.Element | null {
  const [on, setOn] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  const drawing = useRef(false)
  useIpc('screen:set-capture', (v) => {
    setOn(v)
    setPoints([])
  })

  const end = useCallback(() => {
    drawing.current = false
    setOn(false)
    send('screen:capture-end')
  }, [])

  useEffect(() => {
    if (!on) return
    const timer = setTimeout(end, CAPTURE_TIMEOUT_MS)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') end()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [on, end])

  if (!on) return null
  const outline = points.length
    ? outlinePath(
        getStroke(
          points.map((p) => [p.x, p.y]),
          { size: 7, thinning: 0.55 }
        )
      )
    : ''
  return (
    <div
      className="sl-capture"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drawing.current = true
        setPoints([{ x: e.clientX, y: e.clientY }])
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return
        const pts = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
        setPoints((prev) =>
          prev.length >= 5000
            ? prev
            : [...prev, ...pts.map((p) => ({ x: p.clientX, y: p.clientY }))]
        )
      }}
      onPointerUp={() => {
        if (!drawing.current) return
        drawing.current = false
        if (points.length > 1) send('screen:user-drawing', { points, rect: bbox(points) })
        end()
      }}
    >
      <svg className="sl-root" width="100%" height="100%" aria-hidden="true">
        {outline && (
          <g className="sl-ann sl-ann--fill is-live">
            <path className="sl-ann__halo" d={outline} />
            <path className="sl-ann__ink" d={outline} />
          </g>
        )}
      </svg>
      <p className="sl-capture__hint sl-pill">
        <span>Draw around something. Esc to cancel.</span>
      </p>
    </div>
  )
}
