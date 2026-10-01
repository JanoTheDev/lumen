// Eval entry points (T27 stub for the grounding eval, stream 10): ground a query against a
// recorded frame without windows or the agent. The caller supplies `pick`, the model step
// that turns the query into a Target (a live call in the eval runner, a fixture in tests),
// and a screen adapter via coords.setScreenAdapter for the logical rect.
import type { MonitorInfo, Rect, Target } from '@shared/types'
import type { OcrResult, UiaSnapshotResult } from '../agent/commands'
import { frameGeometryOf } from '../actions/coords'
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
