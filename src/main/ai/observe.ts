// Observation and settle waits for the action loop. observe() is one fresh screen context
// plus the keyboard focus; waitForSettle() replaces the fixed sleeps after actions: it ends
// on a window-title change, a focus change, or two consecutive frames that differ < 0.5%,
// and never waits longer than 1.5 s.
import * as commands from '../agent/commands'
import { requireAgent } from '../agent/instance'
import { captureContext } from '../query/capture'
import type { QueryContext } from '../query/context'
import { SAME_RATIO, decodeGray, diffRatio, type GrayImage } from './frames'
import type { FocusInfo, Observation } from './verify'
import { log } from '../logger'

export interface Observed {
  ctx: QueryContext
  obs: Observation
}

const FOCUS_TIMEOUT_MS = 1000
const SETTLE_FRAME_WIDTH = 320
export const SETTLE_MAX_MS = 1500
const SETTLE_INTERVAL_MS = 100
/** Without any visible change, frames only count as settled after this long. */
const SETTLE_MIN_MS = 400

/** The focused element, or null when the agent cannot tell (no UIA). */
export async function readFocus(signal?: AbortSignal): Promise<FocusInfo | null> {
  try {
    const r = await requireAgent().request<Record<string, unknown>>(
      'focus_info',
      {},
      { timeoutMs: FOCUS_TIMEOUT_MS, signal }
    )
    if (!r || r.uia !== true) return null
    const s = (v: unknown): string => (typeof v === 'string' ? v : '')
    return {
      role: s(r.role),
      name: s(r.name),
      editable: r.editable === true,
      valueTail: s(r.valueTail)
    }
  } catch (e) {
    if (signal?.aborted) throw e
    return null
  }
}

export function observationOf(ctx: QueryContext, focus: FocusInfo | null): Observation {
  const frame = ctx.frames[0]
  return {
    at: ctx.at,
    title: ctx.activeWindow,
    image: frame?.data,
    geometry: frame?.geometry,
    uia: ctx.uia,
    focus
  }
}

/** A fresh capture (frame, UIA, lazy OCR) and the keyboard focus, in parallel. */
export async function observe(signal?: AbortSignal): Promise<Observed> {
  const [ctx, focus] = await Promise.all([captureContext(true, { signal }), readFocus(signal)])
  signal?.throwIfAborted()
  return { ctx, obs: observationOf(ctx, focus) }
}

export interface SettleProbe {
  title(signal?: AbortSignal): Promise<string>
  /** A small foreground frame (base64), or null. */
  frame(signal?: AbortSignal): Promise<string | null>
  focus(signal?: AbortSignal): Promise<FocusInfo | null>
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      clearTimeout(t)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const agentProbe: SettleProbe = {
  title: async (signal) => (await commands.activeWindow(requireAgent(), { signal })).title,
  frame: async (signal) => {
    const res = await commands.capture(
      requireAgent(),
      { monitor: 'foreground', maxWidth: SETTLE_FRAME_WIDTH },
      { signal }
    )
    return res.frames[0]?.data ?? null
  },
  focus: readFocus,
  sleep: abortableSleep,
  now: () => Date.now()
}

export type SettleReason = 'title' | 'focus' | 'frames' | 'timeout'

const focusKey = (f: FocusInfo | null | undefined): string => (f ? `${f.role}|${f.name}` : '')

/**
 * Waits until the screen has reacted to an action: the title or the focused element changed,
 * or two consecutive frames are the same (< 0.5% diff). Capped at `maxMs`.
 */
export async function waitForSettle(
  before: Pick<Observation, 'title' | 'image' | 'focus'>,
  signal?: AbortSignal,
  maxMs = SETTLE_MAX_MS,
  probe: SettleProbe = agentProbe
): Promise<{ reason: SettleReason; ms: number }> {
  const t0 = probe.now()
  const base = before.image ? decodeGray(before.image) : null
  let prev: GrayImage | null = null
  let still = 0
  let moved = false
  const watchFocus = !!before.focus
  const finish = (reason: SettleReason): { reason: SettleReason; ms: number } => {
    const ms = probe.now() - t0
    log('step', `settled (${reason}) in ${ms}ms`)
    return { reason, ms }
  }
  while (probe.now() - t0 < maxMs) {
    await probe.sleep(SETTLE_INTERVAL_MS, signal)
    const [title, data, focus] = await Promise.all([
      probe.title(signal).catch(() => before.title),
      probe.frame(signal).catch(() => null),
      watchFocus ? probe.focus(signal).catch(() => null) : Promise.resolve(null)
    ])
    signal?.throwIfAborted()
    if (title !== before.title) return finish('title')
    if (watchFocus && focus && focusKey(focus) !== focusKey(before.focus)) return finish('focus')
    const cur = data ? decodeGray(data) : null
    if (!cur) continue
    if (base && diffRatio(base, cur) >= SAME_RATIO) moved = true
    still = prev && diffRatio(prev, cur) < SAME_RATIO ? still + 1 : 0
    prev = cur
    // Two consecutive equal frames, after the screen moved or a minimum wait (a page that
    // has not started to react yet looks settled too).
    if (still >= 1 && (moved || probe.now() - t0 >= SETTLE_MIN_MS)) return finish('frames')
  }
  return finish('timeout')
}
