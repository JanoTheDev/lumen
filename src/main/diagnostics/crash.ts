// Crash handling: local minidumps only (nothing is uploaded), main keeps running after an
// uncaught error, and a crashed window reloads itself (at most 3 times a minute in total).
import { app, crashReporter, type WebContents } from 'electron'

const RELOAD_LIMIT = 3
const RELOAD_WINDOW_MS = 60_000

/** Sliding-window limiter: true while fewer than `limit` hits happened in `windowMs`. */
export function rateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now
): () => boolean {
  let hits: number[] = []
  return () => {
    const t = now()
    hits = hits.filter((h) => t - h < windowMs)
    if (hits.length >= limit) return false
    hits.push(t)
    return true
  }
}

/** Call before app ready so early crashes are captured too. */
export function startCrashReporter(): void {
  try {
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch (e) {
    console.error('[crash] reporter not started:', (e as Error).message)
  }
}

export function installCrashHandlers(): void {
  process.on('uncaughtException', (e) => {
    console.error('[crash] uncaught exception:', e?.stack ?? e)
  })
  process.on('unhandledRejection', (reason) => {
    const r = reason as Error | undefined
    console.error('[crash] unhandled rejection:', r?.stack ?? r)
  })

  const mayReload = rateLimiter(RELOAD_LIMIT, RELOAD_WINDOW_MS)
  app.on('render-process-gone', (_e, contents: WebContents, details) => {
    console.error(`[crash] renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit' || contents.isDestroyed()) return
    if (!mayReload()) {
      console.error('[crash] renderer crashed too often; not reloading')
      return
    }
    // Reload once the dead process is fully torn down.
    setTimeout(() => {
      if (!contents.isDestroyed()) contents.reload()
    }, 500)
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    console.error(
      `[crash] ${details.type} process gone: ${details.reason} (exit ${details.exitCode})`
    )
  })
}
