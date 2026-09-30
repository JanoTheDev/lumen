// Screen context for a query: active window title + optional screenshot.
// On hotkey-up a capture starts while speech is transcribed; the query reuses that
// in-flight promise instead of capturing a second time.

export interface QueryContext {
  activeWindow: string
  screenshot: string | null
}

const SPECULATIVE_TTL_MS = 4000

let pending: { promise: Promise<QueryContext>; ts: number } | null = null

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
