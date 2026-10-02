// Zoom-crop refine (T14): for a low-confidence or point target, capture ~3x the candidate area
// at full resolution (agent `capture {region}`), ask the vision-refine role for the target's
// centre in crop px, and map it back. Replaces the per-click Computer Use call.
import { z } from 'zod'
import type { Point, Rect } from '@shared/types'
import * as commands from '../agent/commands'
import { requireAgent } from '../agent/instance'
import {
  frameGeometryOf,
  imageToPhys,
  physRectToLogical,
  physToLogical,
  rectCenter,
  type FrameGeometry
} from '../actions/coords'
import { parseJsonAs } from '../ai/json'
import { getProvider, hasVisionModel } from '../ai/providers'
import { log } from '../logger'
import { LOW_CONFIDENCE, type ResolvedTarget } from './resolve-target'
import { withUsageFeature } from '../usage/scope'

export type RefineOutcome = 'agree' | 'moved' | 'not-found' | 'skipped'

export interface RefineResult {
  target: ResolvedTarget
  outcome: RefineOutcome
  ms: number
}

export interface Crop {
  data: string
  geometry: FrameGeometry
}

export interface RefineDeps {
  /** Full-resolution capture of a physical region (clipped to its monitor). */
  capture: (region: Rect, signal?: AbortSignal) => Promise<Crop | null>
  /** Target centre in crop image px, or null when the crop does not show it. */
  locate: (crop: Crop, label: string, signal?: AbortSignal) => Promise<Point | null>
}

/** Logical px within which the refined point counts as agreeing with the first guess. */
export const AGREE_PX = 12
const CROP_FACTOR = 3
const MIN_CROP_LOGICAL = 240
const MAX_CROP_LOGICAL = 900
const MOVED_BOX_LOGICAL = 24
const CROP_MAX_WIDTH = 1024
/** Confidence of a target the refine pass moved. */
const MOVED_CONFIDENCE = 0.7

export function needsRefine(r: ResolvedTarget): boolean {
  // A disabled element is low for a reason a second look cannot fix.
  if (r.notes?.includes('disabled')) return false
  return r.confidence < LOW_CONFIDENCE || r.source === 'point'
}

/** ~3x the target, at least 240 logical px a side, centred on it (physical px). */
export function cropRegion(r: ResolvedTarget): Rect {
  const scale = r.logicalRect.w > 0 ? r.physRect.w / r.logicalRect.w : 1
  const side = (v: number): number =>
    Math.min(
      Math.max(v * CROP_FACTOR, MIN_CROP_LOGICAL * scale),
      Math.max(MAX_CROP_LOGICAL * scale, v)
    )
  const w = Math.round(side(r.physRect.w))
  const h = Math.round(side(r.physRect.h))
  const c = rectCenter(r.physRect)
  return { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h }
}

const refineSchema = z.object({
  found: z.boolean(),
  x: z.number().optional(),
  y: z.number().optional()
})

const REFINE_SYSTEM = `You find one UI element in a zoomed screenshot crop. Reply with JSON {"found": true, "x": <px>, "y": <px>} giving the centre of the element in crop pixels, or {"found": false} if the crop does not clearly show it. Never guess.`

async function captureRegion(region: Rect, signal?: AbortSignal): Promise<Crop | null> {
  const res = await commands.capture(
    requireAgent(),
    { region, maxWidth: CROP_MAX_WIDTH },
    { signal }
  )
  const f = res.frames[0]
  if (!f?.region && !f?.monitor) return null
  return { data: f.data, geometry: frameGeometryOf(f) }
}

async function locateInCrop(
  crop: Crop,
  label: string,
  signal?: AbortSignal
): Promise<Point | null> {
  const { llm, model, effort } = getProvider('vision-refine')
  const { imgW, imgH } = crop.geometry
  const res = await withUsageFeature('refine', () =>
    llm.complete(
      {
        model,
        system: [{ text: REFINE_SYSTEM, cacheable: false }],
        messages: [
          {
            role: 'user',
            content: `The target "${label}" should be in this ${imgW}x${imgH} px crop. Where is its centre?`
          }
        ],
        images: [{ base64: crop.data, detail: 'high' }],
        maxTokens: 120,
        effort,
        schema: refineSchema,
        schemaName: 'lumen_refine'
      },
      signal
    )
  )
  const out = res.data ?? parseJsonAs(res.text, refineSchema)
  if (!out?.found || out.x === undefined || out.y === undefined) return null
  if (out.x < 0 || out.y < 0 || out.x > imgW || out.y > imgH) return null
  return { x: out.x, y: out.y }
}

const defaultDeps: RefineDeps = { capture: captureRegion, locate: locateInCrop }

export function canRefine(): boolean {
  return hasVisionModel()
}

/**
 * Second look at a target. Agreeing within 12 logical px adds 0.2 confidence; a different
 * point moves the target there (confidence at least 0.7); not found lowers it by 0.2.
 * Errors and missing capabilities leave the target unchanged ("skipped").
 */
export async function refineTarget(
  r: ResolvedTarget,
  label: string,
  signal?: AbortSignal,
  deps: RefineDeps = defaultDeps
): Promise<RefineResult> {
  const t0 = Date.now()
  const done = (target: ResolvedTarget, outcome: RefineOutcome): RefineResult => ({
    target,
    outcome,
    ms: Date.now() - t0
  })
  let point: Point | null
  let crop: Crop | null
  try {
    crop = await deps.capture(cropRegion(r), signal)
    if (!crop) return done(r, 'skipped')
    point = await deps.locate(crop, label, signal)
  } catch (e) {
    if (signal?.aborted) throw e
    log('fail', `refine skipped: ${(e as Error).message}`)
    return done(r, 'skipped')
  }
  if (!point) {
    const confidence = Math.max(0, Math.round((r.confidence - 0.2) * 100) / 100)
    return done({ ...r, confidence, notes: [...(r.notes ?? []), 'refine: not found'] }, 'not-found')
  }
  const phys = imageToPhys(crop.geometry, point)
  const before = physToLogical(rectCenter(r.physRect))
  const after = physToLogical(phys)
  if (Math.hypot(after.x - before.x, after.y - before.y) <= AGREE_PX) {
    const confidence = Math.min(1, Math.round((r.confidence + 0.2) * 100) / 100)
    return done({ ...r, confidence }, 'agree')
  }
  const scale = r.logicalRect.w > 0 ? r.physRect.w / r.logicalRect.w : 1
  const w = Math.round(Math.min(r.physRect.w, MOVED_BOX_LOGICAL * scale))
  const h = Math.round(Math.min(r.physRect.h, MOVED_BOX_LOGICAL * scale))
  const physRect = { x: Math.round(phys.x - w / 2), y: Math.round(phys.y - h / 2), w, h }
  return done(
    {
      ...r,
      physRect,
      logicalRect: physRectToLogical(physRect),
      confidence: Math.max(r.confidence, MOVED_CONFIDENCE),
      notes: [...(r.notes ?? []), 'refine: moved']
    },
    'moved'
  )
}
