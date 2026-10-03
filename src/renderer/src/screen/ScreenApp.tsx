// Screen layer renderer: draws one display's ScreenScene. Highlights, buddy, labels and
// annotations are one scene, so a pointer label can never erase a guide box (audit #13).
// Rects arrive in this display's DIP; the SVG viewBox is the window size, so there is no
// scaling maths here (CONTRACTS C4).
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ScreenScene } from '@shared/events'
import type { Point } from '@shared/types'
import { invoke, useIpc } from '../lib/ipc'
import { GridLayer } from '../a11y/GridLayer'
import { MarksLayer } from '../a11y/MarksLayer'
import { ScanLayer } from '../a11y/ScanLayer'
import { DwellRing, DwellUi } from '../a11y/DwellRing'
import { HighlightLabels, HighlightsSvg, type Highlight } from './Highlights'
import { placeHighlightLabels } from './highlight-labels'
import { Buddy, type BuddyConfig } from './Buddy'
import { AnnotationTexts, AnnotationsSvg, CaptureLayer } from './Annotations'
import { usePresence } from './usePresence'
import { FocusLabels, FocusMaskSvg } from './FocusMask'
import { containsPoint } from './geometry'
import '../a11y/a11y-layer.css'

const HIGHLIGHT_EXIT_MS = 140
const MARKS_EXIT_MS = 100

const DEFAULT_BUDDY: BuddyConfig = {
  enabled: false,
  size: 'm',
  color: 'accent',
  followCursor: true
}

function readBuddy(cfg: unknown): BuddyConfig {
  const b = (cfg as { buddy?: Partial<BuddyConfig> } | null)?.buddy
  return { ...DEFAULT_BUDDY, ...b }
}

function rootFontPx(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 16
}

function useView(): { w: number; h: number } {
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const on = (): void => setView({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return view
}

/** Buddy settings and the root font size (uiScale), kept in sync with settings. */
function useLayerConfig(): { buddy: BuddyConfig; fontPx: number } {
  const [buddy, setBuddy] = useState(DEFAULT_BUDDY)
  const [fontPx, setFontPx] = useState(16)
  const apply = (cfg: unknown): void => {
    setBuddy(readBuddy(cfg))
    // The theme engine writes the root font size in its own listener; read it after.
    requestAnimationFrame(() => setFontPx(rootFontPx()))
  }
  useEffect(() => {
    invoke('settings:get')
      .then(apply)
      .catch(() => {})
  }, [])
  useIpc('settings:changed', apply)
  return { buddy, fontPx }
}

type MarksState = { marks: ScreenScene['marks']; exiting: boolean }

/** Marks stay mounted for a short fade-out after "hide numbers". */
function nextMarks(prev: MarksState, marks: ScreenScene['marks']): MarksState {
  if (marks?.length) return { marks, exiting: false }
  if (prev.marks?.length && !prev.exiting) return { marks: prev.marks, exiting: true }
  return prev
}

const highlightKey = (h: Highlight): string => h.id

export function ScreenApp(): JSX.Element {
  const [scene, setScene] = useState<ScreenScene | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)
  const view = useView()
  const { buddy: buddyCfg, fontPx } = useLayerConfig()
  const [highlights, updateHighlights] = usePresence<Highlight>(highlightKey, HIGHLIGHT_EXIT_MS)
  const [marks, setMarks] = useState<MarksState>({ marks: undefined, exiting: false })
  useIpc('screen:render', (s) => {
    performance.mark?.('screen:render-start')
    setScene(s)
    updateHighlights(s.highlights)
    setMarks((prev) => nextMarks(prev, s.marks))
  })
  useEffect(() => {
    if (!marks.exiting) return
    const id = setTimeout(() => setMarks({ marks: undefined, exiting: false }), MARKS_EXIT_MS)
    return () => clearTimeout(id)
  }, [marks])
  useIpc('screen:cursor', setCursor)

  useLayoutEffect(() => {
    try {
      const m = performance.measure('screen:render', 'screen:render-start')
      if (m.duration > 16) console.warn(`[screen] scene render took ${m.duration.toFixed(1)}ms`)
    } catch {
      /* first paint, no mark yet */
    } finally {
      // Entries would pile up in the performance timeline for the life of the window.
      performance.clearMarks?.('screen:render-start')
      performance.clearMeasures?.('screen:render')
    }
  }, [scene])

  const b = scene?.buddy
  const live = useMemo(() => scene?.highlights ?? [], [scene])
  const targetRect = b ? live.find((h) => containsPoint(h.rect, b.to))?.rect : undefined
  const annotations = scene?.annotations ?? []
  const props = { list: highlights, buddyLabel: b?.label, view, fontPx, spotFrom: b?.to }
  const avoid = [
    ...live.map((h) => h.rect).filter((r) => r !== targetRect),
    ...placeHighlightLabels(props).values()
  ]

  return (
    <>
      <svg
        className="sl-root"
        width={view.w}
        height={view.h}
        viewBox={`0 0 ${view.w} ${view.h}`}
        aria-hidden="true"
      >
        {scene?.focus && <FocusMaskSvg focus={scene.focus} view={view} />}
        <HighlightsSvg {...props} />
        <AnnotationsSvg list={annotations} />
      </svg>
      {scene?.focus && <FocusLabels focus={scene.focus} />}
      <HighlightLabels {...props} />
      <AnnotationTexts list={annotations} />
      {scene?.grid && <GridLayer grid={scene.grid} />}
      {marks.marks?.length ? <MarksLayer marks={marks.marks} exiting={marks.exiting} /> : null}
      {scene?.dwellUi && <DwellUi ui={scene.dwellUi} />}
      {scene?.scan && <ScanLayer scan={scene.scan} />}
      <Buddy
        buddy={b}
        targetRect={targetRect}
        avoid={avoid}
        cursor={cursor}
        view={view}
        cfg={buddyCfg}
        fontPx={fontPx}
        worker={scene?.worker}
      />
      <DwellRing />
      <CaptureLayer />
    </>
  )
}
