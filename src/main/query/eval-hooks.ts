// Eval entry points, callable headless (no windows, no agent): `routeOnly` runs the local
// prefilter and then the LLM router on one utterance; `groundOnly` grounds a query against a
// recorded frame. For grounding the caller supplies `pick`, the model step that turns the query
// into a Target (a live call in the eval runner, a fixture in tests), and a screen adapter via
// coords.setScreenAdapter for the logical rect. `setDeterministic(true)` (or routeOnly's
// `deterministic`) makes every later call in the process send temperature 0 where the model
// accepts it; neither API takes a seed.
import type { MonitorInfo, Rect, Target } from '@shared/types'
import type { OcrResult, UiaSnapshotResult } from '../agent/commands'
import { frameGeometryOf } from '../actions/coords'
import { setDeterministic } from '../ai/providers'
import { prefilter, routeWithLlm, type PrefilterHit, type Route } from './router'
import { resolveTarget, type GroundingContext, type ResolvedTarget } from './resolve-target'
import { serializeElements, uiaQuality, type UiaQuality } from './uia-list'

/** frame.json of a fixture plus the image. */
export interface GroundFrame {
  data: string
  width: number
  height: number
  monitor?: MonitorInfo
  region?: Rect
}

export interface PickInput {
  query: string
  frame: GroundFrame
  /** Compact elements list as the main model would see it, when UIA is given. */
  elements?: string
  uiaQuality: UiaQuality
}

export type PickTarget = (input: PickInput) => Promise<Target | null>

export async function groundOnly(
  frame: GroundFrame,
  uia: UiaSnapshotResult | undefined,
  ocr: OcrResult | undefined,
  query: string,
  pick: PickTarget
): Promise<ResolvedTarget | null> {
  const geometry = frameGeometryOf(frame)
  const frameRect = {
    x: geometry.originX,
    y: geometry.originY,
    w: geometry.width,
    h: geometry.height
  }
  const ctx: GroundingContext = {
    frames: [{ label: '1', geometry, monitor: frame.monitor }],
    uia,
    ocr: async () => ocr ?? null
  }
  const target = await pick({
    query,
    frame,
    elements: serializeElements(uia, geometry)?.text,
    uiaQuality: uiaQuality(uia, frameRect)
  })
  return target ? resolveTarget(target, ctx) : null
}

/** What the app knows when the utterance arrives; everything defaults to a quiet desktop. */
export interface RouteStub {
  foreground?: string
  guideActive?: boolean
  hasLastGuide?: boolean
  hasLastTask?: boolean
}

export type RouteOnlyResult =
  | { stage: 'prefilter'; hit: PrefilterHit }
  | { stage: 'router'; route: Route | null; ms: number }

export async function routeOnly(
  utterance: string,
  stub: RouteStub = {},
  opts: { deterministic?: boolean; signal?: AbortSignal } = {}
): Promise<RouteOnlyResult> {
  const hit = prefilter(utterance, {
    guideActive: !!stub.guideActive,
    hasLastGuide: !!stub.hasLastGuide,
    hasLastTask: !!stub.hasLastTask
  })
  if (hit) return { stage: 'prefilter', hit }
  if (opts.deterministic) setDeterministic(true)
  const t0 = Date.now()
  const route = await routeWithLlm(
    { utterance, activeWindow: stub.foreground ?? 'Desktop', guideActive: !!stub.guideActive },
    opts.signal
  )
  return { stage: 'router', route, ms: Date.now() - t0 }
}

export { setDeterministic }
