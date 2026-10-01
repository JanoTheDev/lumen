// Screen context for one query (T12): the captured frames with their monitor geometry, the
// foreground window, an optional UIA snapshot and OCR that only runs when something needs it.
// On hotkey-up a capture starts while speech is transcribed; the query reuses that in-flight
// promise instead of capturing a second time. The latest context also serves the executor,
// which runs actions after the turn (renderer round trip) against the frame the model saw.
import type { MonitorInfo, Rect } from '@shared/types'
import type { FrameGeometry } from '../actions/coords'
import type { OcrResult, UiaSnapshotResult } from '../agent/commands'
import type { UiaQuality } from './uia-list'

/** One captured screenshot as the model sees it. */
export interface Frame {
  /** Agent frame id (cached agent-side for a few seconds, for ocr/marks reuse). */
  id: string
  /** Name the model uses in point/rect targets: "1", "2", ... */
  label: string
  geometry: FrameGeometry
  /** Absent for a v1 `screenshot`. */
  monitor?: MonitorInfo
  mime: string
  /** Base64 image of the screen, without marks. */
  data: string
}

export interface Foreground {
  title: string
  hwnd?: number
  process?: string
  /** Physical px; from active_window (v2) or the UIA root. */
  rect?: Rect
  monitorId?: number
}

/** Skill pack facts the grounding uses (C8 skill.json); filled in by T23. */
export interface SkillInfo {
  id: string
  uiaQuality?: UiaQuality
}

export interface QueryContext {
  frames: Frame[]
  foreground: Foreground
  uia?: UiaSnapshotResult
  uiaQuality?: UiaQuality
  /** OCR of frame "1", run on first use and shared afterwards; null when unavailable. */
  ocr: () => Promise<OcrResult | null>
  skill?: SkillInfo
  signal?: AbortSignal
  /** Foreground window title (what older call sites pass around). */
  activeWindow: string
  /** Image sent to the model for frame "1" (marks drawn in when set), or null. */
  screenshot: string | null
  /** When the capture finished (ms epoch). */
  at: number
}

const SPECULATIVE_TTL_MS = 4000

let pending: { promise: Promise<QueryContext>; ts: number } | null = null
let latest: QueryContext | null = null

export function startSpeculativeCapture(capture: () => Promise<QueryContext>): void {
  const promise = capture()
  // Avoid unhandled rejections when nobody consumes it; consumers see the rejection.
  promise.catch(() => {})
  pending = { promise, ts: Date.now() }
}

/** Returns the pending speculative capture if it is fresh, and consumes it. */
export function takeSpeculative(now = Date.now()): Promise<QueryContext> | null {
  const p = pending
  pending = null
  if (!p || now - p.ts > SPECULATIVE_TTL_MS) return null
  return p.promise
}

export function clearSpeculative(): void {
  pending = null
}

/** The context of the last capture with a screenshot (what the executor resolves against). */
export function currentContext(): QueryContext | null {
  return latest
}

export function setCurrentContext(ctx: QueryContext | null): void {
  latest = ctx
}

/** Memoizes an OCR call; a failure resolves to null and is not retried. */
export function lazyOcr(run: () => Promise<OcrResult>): () => Promise<OcrResult | null> {
  let p: Promise<OcrResult | null> | null = null
  return () => (p ??= run().catch(() => null))
}

const noOcr = (): Promise<OcrResult | null> => Promise.resolve(null)

/** A context without a screenshot (the route said the screen is not needed). */
export function windowOnlyContext(foreground: Foreground | string): QueryContext {
  const fg = typeof foreground === 'string' ? { title: foreground } : foreground
  return {
    frames: [],
    foreground: fg,
    ocr: noOcr,
    activeWindow: fg.title,
    screenshot: null,
    at: Date.now()
  }
}

export function needsScreenshot(prompt: string): boolean {
  const p = prompt.toLowerCase()

  // Pure launch with no disambiguation → no screenshot needed
  const isLaunch = /^(open|launch|go to|navigate to)\s+\w/i.test(prompt)
  const hasDisambiguator =
    /\b(from|first|second|third|fourth|fifth|last|latest|recent|top|#\d+|\d+(st|nd|rd|th))\b/i.test(
      p
    )
  if (isLaunch && !hasDisambiguator) return false

  return /\b(this|screen|here|that|visible|what.*see|how.*do|button|click|navigate|window|app|page|ui|cursor|tab|menu|field|input|form|element|icon|image|show me|where is|find|select|highlight|email|compose|reply|draft|message|write|rewrite|linkedin|gmail|twitter|slack|notion|edit|insert|paste|recent|latest|first|second|third|last|from|sender|inbox|open|refund|payment|filter|effect|caption)\b/i.test(
    prompt
  )
}
