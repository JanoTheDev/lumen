// Highlights on the screen layer (surfaces.md §3.2–3.6): target rings, point rings,
// dim-reveal spotlight and success / failure feedback, plus their number badges and labels.
// Geometry moves with CSS transitions on the spring curves from motion.ts, so a guide step
// that keeps its id morphs to the new rect instead of popping.
import { useEffect, useState } from 'react'
import type { ScreenScene } from '@shared/events'
import type { Rect } from '@shared/types'
import type { Present } from './scene'
import { showHighlightLabel } from './scene'
import { center, inflate, type Size } from './geometry'
import { pillSize, placeLabels } from './labels'

export type Highlight = ScreenScene['highlights'][number]

const RING_PAD = 6
const RING_RADIUS = 8
const HOLE_PAD = 8
const HOLE_RADIUS = 10

/** Rect geometry as CSS so `x/y/width/height` can transition. */
function geo(r: Rect): React.CSSProperties {
  return {
    x: r.x,
    y: r.y,
    width: Math.max(0, r.w),
    height: Math.max(0, r.h)
  } as React.CSSProperties
}

function ringRect(h: Highlight, fontPx: number): Rect {
  if (h.style === 'ring') {
    const d = 2.5 * fontPx
    const c = center(h.rect)
    return { x: c.x - d / 2, y: c.y - d / 2, w: d, h: d }
  }
  return inflate(h.rect, h.style === 'dim-reveal' ? HOLE_PAD : RING_PAD)
}

/** The three-stroke ring: dark halo, accent, light inner line. Reads on any background. */
function Ring({ r, radius, tone }: { r: Rect; radius: number; tone: string }): JSX.Element {
  const inner = inflate(r, -2.5)
  return (
    <>
      <rect className="sl-ring__halo" rx={radius} style={geo(r)} />
      <rect className={`sl-ring__main sl-tone-${tone}`} rx={radius} pathLength={1} style={geo(r)} />
      <rect className="sl-ring__inner" rx={Math.max(0, radius - 2.5)} style={geo(inner)} />
    </>
  )
}

/** Check (success) or cross (failure) at the ring's top-right, drawn on. */
function StatusIcon({ r, ok }: { r: Rect; ok: boolean }): JSX.Element {
  const cx = r.x + r.w
  const cy = r.y
  const d = ok
    ? `M ${cx - 5} ${cy} L ${cx - 1.5} ${cy + 3.5} L ${cx + 5} ${cy - 3.5}`
    : `M ${cx - 4} ${cy - 4} L ${cx + 4} ${cy + 4} M ${cx + 4} ${cy - 4} L ${cx - 4} ${cy + 4}`
  return (
    <g className="sl-status">
      <circle
        cx={cx}
        cy={cy}
        r={11}
        className={`sl-status__disc sl-tone-${ok ? 'success' : 'danger'}`}
      />
      <path d={d} pathLength={1} className="sl-status__mark" />
    </g>
  )
}

function toneOf(h: Highlight): string {
  if (h.style === 'success') return 'success'
  if (h.style === 'failure') return 'danger'
  return 'accent'
}

/**
 * Starts a value at `from` and switches to `to` on the next frame, so the CSS transition
 * runs on mount (the spotlight closing in from the buddy).
 */
function useEnterFrom<T>(from: T, to: T): T {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return entered ? to : from
}

function Hole({ r, from }: { r: Rect; from: Rect }): JSX.Element {
  const cur = useEnterFrom(from, r)
  return <rect className="sl-hole" rx={HOLE_RADIUS} style={geo(cur)} />
}

export interface HighlightsProps {
  list: Present<Highlight>[]
  /** Where the spotlight grows from (the buddy), if anywhere. */
  spotFrom?: { x: number; y: number }
  buddyLabel?: string
  view: Size
  fontPx: number
}

export function HighlightsSvg({ list, spotFrom, view, fontPx }: HighlightsProps): JSX.Element {
  const holes = list.filter((p) => p.item.style === 'dim-reveal')
  const dimLive = holes.some((p) => !p.exiting)
  return (
    <>
      {holes.length > 0 && (
        <>
          <defs>
            <mask id="sl-dim" maskUnits="userSpaceOnUse" x={0} y={0} width={view.w} height={view.h}>
              <rect x={0} y={0} width={view.w} height={view.h} fill="#fff" />
              {holes.map((p) => {
                const r = ringRect(p.item, fontPx)
                const from = spotFrom
                  ? { x: spotFrom.x - 4, y: spotFrom.y - 4, w: 8, h: 8 }
                  : inflate(r, 48)
                return <Hole key={p.key} r={r} from={from} />
              })}
            </mask>
          </defs>
          <rect
            className={`sl-scrim${dimLive ? '' : ' is-exit'}`}
            x={0}
            y={0}
            width={view.w}
            height={view.h}
            mask="url(#sl-dim)"
          />
        </>
      )}
      {list.map((p) => {
        const h = p.item
        const r = ringRect(h, fontPx)
        const radius =
          h.style === 'ring' ? r.w / 2 : h.style === 'dim-reveal' ? HOLE_RADIUS : RING_RADIUS
        return (
          <g
            key={p.key}
            className={`sl-hl sl-hl--${h.style}${p.exiting ? ' is-exit' : ''}`}
            data-id={p.key}
          >
            <Ring r={r} radius={radius} tone={toneOf(h)} />
            {(h.style === 'success' || h.style === 'failure') && (
              <StatusIcon r={r} ok={h.style === 'success'} />
            )}
          </g>
        )
      })}
    </>
  )
}

/** Number badges and label pills, as HTML so text wraps and stays crisp. */
export function HighlightLabels({ list, buddyLabel, view, fontPx }: HighlightsProps): JSX.Element {
  const rings = list.map((p) => ({ p, r: ringRect(p.item, fontPx) }))
  const obstacles = rings.map((x) => x.r)
  const badge = 1.5 * fontPx
  const requests = rings
    .filter(({ p }) => showHighlightLabel(p.item.label, buddyLabel))
    .map(({ p, r }) => ({
      id: p.key,
      anchor: p.item.n != null ? { x: r.x, y: r.y - badge / 2, w: r.w, h: r.h + badge / 2 } : r,
      size: pillSize(p.item.label!, Math.max(14, fontPx))
    }))
  const placed = placeLabels(requests, obstacles, view)
  return (
    <div className="sl-labels" aria-hidden="true">
      {rings.map(({ p, r }) => {
        const pill = placed.get(p.key)
        const exit = p.exiting ? ' is-exit' : ''
        return [
          p.item.n != null && (
            <span
              key={`${p.key}-n`}
              className={`sl-badge${exit}`}
              style={{
                width: badge,
                height: badge,
                transform: `translate(${r.x - badge / 2}px, ${r.y - badge / 2}px)`
              }}
            >
              {p.item.n}
            </span>
          ),
          pill && (
            <div
              key={`${p.key}-l`}
              className={`sl-pill sl-hl-label${exit}`}
              style={{ transform: `translate(${pill.x}px, ${pill.y}px)` }}
            >
              <span>{p.item.label}</span>
            </div>
          )
        ]
      })}
    </div>
  )
}
