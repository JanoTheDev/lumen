// Gathers a QueryContext from the agent: the foreground monitor's frame (with geometry), the
// foreground window and a UIA snapshot, in parallel. Lumen's own highlight layer is hidden
// first so it is not in the image; the foreground app is never changed (no focus_browser).
import type { AgentBridge } from '../agent/bridge'
import * as commands from '../agent/commands'
import { requireAgent } from '../agent/instance'
import { frameGeometryOf, setCurrentFrame } from '../actions/coords'
import { log } from '../logger'
import { sleep } from '../util'
import * as highlight from '../windows/highlight'
import {
  lazyOcr,
  setCurrentContext,
  windowOnlyContext,
  type Foreground,
  type Frame,
  type QueryContext
} from './context'
import { buildMarks, type MarksTable } from './marks'
import { matchSkill } from '../ai/skills'
import { nodesOnFrame, uiaQuality, type UiaQuality } from './uia-list'
import { orderFrames } from './screens'

export interface CaptureOptions {
  /** Every monitor instead of the foreground one (router needsAllScreens). */
  allScreens?: boolean
  signal?: AbortSignal
}

const MAX_IMAGE_WIDTH = 1280
const UIA_TIMEOUT_MS = 2000

async function foregroundOf(agent: AgentBridge, signal?: AbortSignal): Promise<Foreground> {
  const w = await commands.activeWindow(agent, { signal })
  return { title: w.title, hwnd: w.hwnd, process: w.process, rect: w.rect, monitorId: w.monitor }
}

async function framesOf(
  agent: AgentBridge,
  allScreens: boolean,
  signal?: AbortSignal
): Promise<Frame[]> {
  const res = await commands.capture(
    agent,
    { monitor: allScreens ? 'all' : 'foreground', maxWidth: MAX_IMAGE_WIDTH },
    { signal }
  )
  return res.frames.map((f, i) => ({
    id: f.id,
    label: String(i + 1),
    geometry: frameGeometryOf(f),
    monitor: f.monitor,
    mime: f.mime,
    data: f.data
  }))
}

function ocrFor(agent: AgentBridge, frame: Frame | undefined): QueryContext['ocr'] {
  return lazyOcr(async () => {
    if (frame && !frame.id.startsWith('v1-')) {
      try {
        return await commands.ocr(agent, { frameId: frame.id })
      } catch (e) {
        // The agent keeps frames ~5 s; OCR a fresh capture of the same monitor instead.
        if ((e as { code?: string }).code !== 'E_NOT_FOUND') throw e
      }
    }
    const region = frame?.monitor ? frame.monitor.rect : undefined
    return commands.ocr(agent, region ? { region } : {})
  })
}

/**
 * Set-of-marks (T15) when UIA is poor: OCR the frame, build the marks table and let the agent
 * draw the numbers into the frame's JPEG. Null when there is nothing to mark or it failed.
 */
async function setOfMarks(
  agent: AgentBridge,
  ctx: QueryContext,
  frame: Frame,
  quality: UiaQuality,
  signal?: AbortSignal
): Promise<{ marks: MarksTable; data: string } | null> {
  const g = frame.geometry
  const frameRect = { x: g.originX, y: g.originY, w: g.width, h: g.height }
  const ocr = await ctx.ocr()
  const marks = buildMarks({
    nodes: nodesOnFrame(ctx.uia, frameRect),
    ocrLines: ocr?.lines ?? [],
    frame: frameRect,
    quality
  })
  if (!marks.length) return null
  const drawn = await commands.marksRender(
    agent,
    {
      frameId: frame.id,
      marks: marks.map((m) => ({ n: m.n, rect: m.physRect })),
      maxWidth: MAX_IMAGE_WIDTH
    },
    { signal }
  )
  // The marked image must have the frame's size, or targets in it would map wrongly.
  if (drawn.width !== g.imgW || drawn.height !== g.imgH) return null
  return { marks, data: drawn.data }
}

/** Active window plus, when asked, the screen: frames, UIA snapshot and lazy OCR. */
export async function captureContext(
  withScreenshot: boolean,
  opts: CaptureOptions = {}
): Promise<QueryContext> {
  const agent = requireAgent()
  const { signal } = opts
  if (!withScreenshot) {
    const fg = await foregroundOf(agent, signal)
    return { ...windowOnlyContext(fg), skill: matchSkill(fg) ?? undefined }
  }
  if (highlight.isVisible()) {
    highlight.hide()
    await sleep(32)
  }
  const started = Date.now()
  const [foreground, captured, uia] = await Promise.all([
    foregroundOf(agent, signal),
    framesOf(agent, !!opts.allScreens, signal),
    commands
      .uiaSnapshot(
        agent,
        { scope: 'foreground', maxNodes: 400, interactiveOnly: true },
        { signal, timeoutMs: UIA_TIMEOUT_MS }
      )
      .catch(() => undefined)
  ])
  // Foreground monitor = frame "1" (marks, UIA list); the others follow by position.
  const frames = orderFrames(captured, foreground.monitorId)
  const first = frames[0]
  if (!foreground.rect && uia) foreground.rect = uia.root.rect
  const skill = matchSkill(foreground) ?? undefined
  const frameRect = first && {
    x: first.geometry.originX,
    y: first.geometry.originY,
    w: first.geometry.width,
    h: first.geometry.height
  }
  // No snapshot (UIA timed out or unsupported) counts as "none": marks only.
  const quality = frameRect
    ? uiaQuality(uia, frameRect, foreground.rect, skill?.uiaQuality)
    : undefined
  const ctx: QueryContext = {
    frames,
    foreground,
    uia,
    uiaQuality: quality,
    skill,
    ocr: ocrFor(agent, first),
    signal,
    activeWindow: foreground.title,
    screenshot: first?.data ?? null,
    at: Date.now()
  }
  let marksNote = ''
  if (first && quality && quality !== 'good' && !first.id.startsWith('v1-')) {
    const t0 = Date.now()
    const marked = await setOfMarks(agent, ctx, first, quality, signal).catch((e) => {
      log('fail', `set-of-marks skipped: ${(e as Error).message}`)
      return null
    })
    if (marked) {
      ctx.marks = marked.marks
      ctx.screenshot = marked.data
      marksNote = ` | ${marked.marks.length} marks ${Date.now() - t0}ms`
    }
  }
  if (first) {
    const g = first.geometry
    const onFrame = uia && frameRect ? nodesOnFrame(uia, frameRect).length : 0
    log(
      'plan',
      `context: frame ${first.label} ${g.imgW}x${g.imgH} ← phys ${g.width}x${g.height} @(${g.originX},${g.originY})` +
        `${first.monitor ? ` monitor ${first.monitor.id} x${first.monitor.scale}` : ' (v1 screenshot)'}` +
        ` | uia ${uia ? `${onFrame} nodes, ${quality}` : 'none'}${marksNote}` +
        `${frames.length > 1 ? ` | +${frames.length - 1} more screens` : ''}` +
        `${skill ? ` | skill ${skill.id}` : ''} | ${Date.now() - started}ms`
    )
    setCurrentFrame(g)
  }
  setCurrentContext(ctx)
  return ctx
}

/** A fresh foreground capture for planner/research steps; returns frame "1"'s image. */
export async function captureScreenshot(signal?: AbortSignal): Promise<string> {
  const ctx = await captureContext(true, { signal })
  if (!ctx.screenshot) throw new Error('capture returned no frame')
  return ctx.screenshot
}
