// resolveTarget (T13, CONTRACTS C4): turns a model Target into a physical + logical rect with a
// confidence. Sources in priority order: element (UIA id) → mark (this turn's marks table) →
// text (UIA name, then OCR, with nth in reading order) → point/rect (image px of a frame).
// All conversions go through actions/coords.ts. Confidence follows grounding.md.
import type { ElementNode, MonitorInfo, Rect, Target } from '@shared/types'
import type { OcrResult, OcrWord, UiaSnapshotResult } from '../agent/commands'
import {
  currentFrame,
  imageRectToPhys,
  physRectToLogical,
  rectCenter,
  type FrameGeometry
} from '../actions/coords'
import { currentContext } from './context'
import { findMark, type MarksTable } from './marks'
import { ocrNorm, pickNth, sortReading } from './nth'
import { elementIndex, isInteractive } from './uia-list'

export type TargetSource = 'element' | 'mark' | 'text' | 'point' | 'rect'

export interface ResolvedTarget {
  physRect: Rect
  logicalRect: Rect
  monitorId: number
  elementId?: string
  /** 0..1, see CONFIDENCE. */
  confidence: number
  source: TargetSource
  /** Why the confidence was lowered: disabled, tiny, off-window, ambiguous, fuzzy. */
  notes?: string[]
}

/** What the resolver needs from a QueryContext (a QueryContext satisfies it). */
export interface GroundingContext {
  frames: { label: string; geometry: FrameGeometry; monitor?: MonitorInfo }[]
  foreground?: { rect?: Rect }
  uia?: UiaSnapshotResult
  marks?: MarksTable
  ocr?: () => Promise<OcrResult | null>
}

/** The latest capture's context, or just the current frame geometry before any capture. */
export function groundingNow(): GroundingContext {
  return currentContext() ?? { frames: [{ label: '1', geometry: currentFrame() }] }
}

export const CONFIDENCE = {
  element: 0.95,
  markUia: 0.9,
  markOcr: 0.8,
  markRegion: 0.7,
  textUnique: 0.85,
  textNth: 0.75,
  textFuzzy: 0.6,
  point: 0.5,
  rect: 0.55,
  disabled: 0.3,
  tinyPenalty: 0.2,
  offWindowPenalty: 0.3
} as const

/** Below this a click is refined (T14) and, if still low, confirmed with the user. */
export const LOW_CONFIDENCE = 0.6
/** Smallest logical size (px) a target can have without a penalty. */
const MIN_LOGICAL_SIDE = 8
/** Box drawn around a point target, in image px. */
export const POINT_BOX = 32

interface Hit {
  rect: Rect
  confidence: number
  elementId?: string
  monitorId?: number
  notes?: string[]
}

function frameFor(
  ctx: GroundingContext,
  label?: string
): GroundingContext['frames'][number] | undefined {
  return ctx.frames.find((f) => f.label === label) ?? ctx.frames[0]
}

function inside(pt: { x: number; y: number }, r: Rect): boolean {
  return pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h
}

function monitorOf(ctx: GroundingContext, rect: Rect): number {
  const c = rectCenter(rect)
  const f = ctx.frames.find((fr) => {
    const g = fr.geometry
    return inside(c, { x: g.originX, y: g.originY, w: g.width, h: g.height })
  })
  return f?.monitor?.id ?? ctx.frames[0]?.monitor?.id ?? 0
}

/** Lowercase, OCR-confusable characters folded, punctuation dropped, spaces collapsed. */
export function normText(s: string): string {
  return ocrNorm(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function union(rects: Rect[]): Rect {
  const x1 = Math.min(...rects.map((r) => r.x))
  const y1 = Math.min(...rects.map((r) => r.y))
  const x2 = Math.max(...rects.map((r) => r.x + r.w))
  const y2 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Exact word-sequence matches of `query` in OCR output, as rects (unsorted). */
export function ocrExactMatches(ocr: OcrResult, query: string): Rect[] {
  const q = normText(query).split(' ').filter(Boolean)
  if (!q.length) return []
  const byLine = new Map<number, OcrWord[]>()
  for (const w of ocr.words) {
    if (w.lineIndex === undefined) continue
    const list = byLine.get(w.lineIndex) ?? []
    list.push(w)
    byLine.set(w.lineIndex, list)
  }
  if (!byLine.size) {
    // No word grouping: whole lines only.
    return ocr.lines.filter((l) => normText(l.text) === q.join(' ')).map((l) => l.rect)
  }
  const hits: Rect[] = []
  for (const words of byLine.values()) {
    const tokens = words
      .map((w) => ({ w, t: normText(w.text) }))
      .filter((x) => x.t)
      .flatMap((x) => x.t.split(' ').map((t) => ({ w: x.w, t })))
    for (let i = 0; i + q.length <= tokens.length; i++) {
      if (q.every((t, j) => tokens[i + j].t === t)) {
        hits.push(
          union([...new Set(tokens.slice(i, i + q.length).map((x) => x.w))].map((w) => w.rect))
        )
      }
    }
  }
  return hits
}

/** Lines that contain the query (fuzzy fallback). */
function ocrFuzzyMatches(ocr: OcrResult, query: string): Rect[] {
  const q = normText(query)
  if (q.length < 2) return []
  return ocr.lines.filter((l) => normText(l.text).includes(q)).map((l) => l.rect)
}

/** One of several matches: by nth in reading order, else the first (ambiguous). */
function choose(
  rects: Rect[],
  nth: number | undefined,
  conf: { unique: number; nth: number; ambiguous: number }
): { rect: Rect; confidence: number; notes?: string[] } | null {
  if (!rects.length) return null
  const ordered = sortReading(rects, (r) => r)
  if (nth !== undefined && nth !== 0) {
    const rect = pickNth(ordered, nth)
    if (!rect) return null
    return { rect, confidence: ordered.length === 1 ? conf.unique : conf.nth }
  }
  if (ordered.length === 1) return { rect: ordered[0], confidence: conf.unique }
  return { rect: ordered[0], confidence: conf.ambiguous, notes: [`${ordered.length} matches`] }
}

async function resolveText(
  t: Extract<Target, { kind: 'text' }>,
  ctx: GroundingContext
): Promise<Hit | null> {
  const q = normText(t.text)
  if (!q) return null
  // UIA names first: exact, no OCR round trip, and the element id comes along.
  if (ctx.uia) {
    const frame = ctx.frames[0]?.geometry
    const named = [...elementIndex(ctx.uia).values()].filter(
      (n) =>
        isInteractive(n) &&
        n.rect.w > 0 &&
        n.rect.h > 0 &&
        normText(n.name) === q &&
        (!frame ||
          inside(rectCenter(n.rect), {
            x: frame.originX,
            y: frame.originY,
            w: frame.width,
            h: frame.height
          }))
    )
    const ordered = sortReading(named, (n) => n.rect)
    const node: ElementNode | undefined =
      t.nth !== undefined && t.nth !== 0
        ? pickNth(ordered, t.nth)
        : ordered.length === 1
          ? ordered[0]
          : undefined
    if (node) {
      const hit: Hit = {
        rect: node.rect,
        confidence: ordered.length === 1 ? CONFIDENCE.textUnique : CONFIDENCE.textNth,
        elementId: node.id,
        monitorId: node.monitorId
      }
      if (!node.enabled) return { ...hit, confidence: CONFIDENCE.disabled, notes: ['disabled'] }
      return hit
    }
  }
  const ocr = ctx.ocr ? await ctx.ocr() : null
  if (!ocr) return null
  const exact = choose(ocrExactMatches(ocr, t.text), t.nth, {
    unique: CONFIDENCE.textUnique,
    nth: CONFIDENCE.textNth,
    ambiguous: CONFIDENCE.textFuzzy
  })
  if (exact) return exact
  const fuzzy = choose(ocrFuzzyMatches(ocr, t.text), t.nth, {
    unique: CONFIDENCE.textFuzzy,
    nth: CONFIDENCE.textFuzzy,
    ambiguous: CONFIDENCE.textFuzzy - 0.1
  })
  return fuzzy && { ...fuzzy, notes: [...(fuzzy.notes ?? []), 'fuzzy'] }
}

function resolveImage(
  rect: Rect,
  label: string,
  confidence: number,
  ctx: GroundingContext
): Hit | null {
  const frame = frameFor(ctx, label)
  if (!frame) return null
  const g = frame.geometry
  // Never guess outside the image the model saw.
  if (!inside(rectCenter(rect), { x: 0, y: 0, w: g.imgW, h: g.imgH })) return null
  return { rect: imageRectToPhys(g, rect), confidence, monitorId: frame.monitor?.id }
}

async function resolveHit(target: Target, ctx: GroundingContext): Promise<Hit | null> {
  switch (target.kind) {
    case 'element': {
      const node = elementIndex(ctx.uia).get(target.id)
      if (!node || node.rect.w <= 0 || node.rect.h <= 0) return null
      const hit = { rect: node.rect, elementId: node.id, monitorId: node.monitorId }
      return node.enabled
        ? { ...hit, confidence: CONFIDENCE.element }
        : { ...hit, confidence: CONFIDENCE.disabled, notes: ['disabled'] }
    }
    case 'mark': {
      const mark = findMark(ctx.marks, target.n)
      if (!mark) return null
      const confidence =
        mark.source === 'uia'
          ? CONFIDENCE.markUia
          : mark.source === 'ocr'
            ? CONFIDENCE.markOcr
            : CONFIDENCE.markRegion
      return { rect: mark.physRect, confidence, elementId: mark.elementId }
    }
    case 'text':
      return resolveText(target, ctx)
    case 'point':
      return resolveImage(
        {
          x: target.x - POINT_BOX / 2,
          y: target.y - POINT_BOX / 2,
          w: POINT_BOX,
          h: POINT_BOX
        },
        target.frame,
        CONFIDENCE.point,
        ctx
      )
    case 'rect':
      if (target.w <= 0 || target.h <= 0) return null
      return resolveImage(
        { x: target.x, y: target.y, w: target.w, h: target.h },
        target.frame,
        CONFIDENCE.rect,
        ctx
      )
  }
}

/** Resolves one target, or null when it cannot be found (never a guessed rect). */
export async function resolveTarget(
  target: Target,
  ctx: GroundingContext
): Promise<ResolvedTarget | null> {
  const hit = await resolveHit(target, ctx)
  if (!hit) return null
  const notes = [...(hit.notes ?? [])]
  let confidence = hit.confidence
  const logicalRect = physRectToLogical(hit.rect)
  if (logicalRect.w < MIN_LOGICAL_SIDE || logicalRect.h < MIN_LOGICAL_SIDE) {
    confidence -= CONFIDENCE.tinyPenalty
    notes.push('tiny')
  }
  const win = ctx.foreground?.rect
  if (win && win.w > 0 && win.h > 0 && !inside(rectCenter(hit.rect), win)) {
    confidence -= CONFIDENCE.offWindowPenalty
    notes.push('off-window')
  }
  return {
    physRect: hit.rect,
    logicalRect,
    monitorId: hit.monitorId ?? monitorOf(ctx, hit.rect),
    ...(hit.elementId ? { elementId: hit.elementId } : {}),
    confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)),
    source: target.kind,
    ...(notes.length ? { notes } : {})
  }
}

/** The first target that resolves (callers list them in priority order). */
export async function resolveFirst(
  targets: Target[],
  ctx: GroundingContext
): Promise<ResolvedTarget | null> {
  for (const t of targets) {
    const r = await resolveTarget(t, ctx)
    if (r) return r
  }
  return null
}

export function describeResolved(r: ResolvedTarget): string {
  const p = r.physRect
  return `${r.source}${r.elementId ? ` ${r.elementId}` : ''} → phys (${p.x},${p.y},${p.w},${p.h}) monitor ${r.monitorId} conf ${r.confidence}${r.notes ? ` [${r.notes.join(', ')}]` : ''}`
}
