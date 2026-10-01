// Global Escape cancels in-flight work. It is registered only while something needs it
// (the HUD is open or a turn is running) so Escape is not stolen from other apps.
import { globalShortcut } from 'electron'
import { log } from '../logger'
import { hasActiveScope } from '../query/cancel'

const WATCHDOG_MS = 60_000

let count = 0
const holders = new Set<string>()
let watchdog: ReturnType<typeof setTimeout> | null = null
let handler: () => void = () => {}
let registerFailedLogged = false
/** Sessions that legitimately outlive the watchdog (hands-free dictation runs up to 3 min). */
const keepAlive = new Set<() => boolean>()

export function setEscapeHandler(fn: () => void): void {
  handler = fn
}

function sync(): void {
  const registered = globalShortcut.isRegistered('Escape')
  if (count > 0 && !registered) {
    // Another app owning Escape globally makes this fail; Escape then only works in our windows.
    if (!globalShortcut.register('Escape', () => handler()) && !registerFailedLogged) {
      registerFailedLogged = true
      log('fail', 'could not register global Escape (in use by another app)')
    }
  } else if (count === 0 && registered) globalShortcut.unregister('Escape')
  if (count === 0 && watchdog) {
    clearTimeout(watchdog)
    watchdog = null
  }
}

// A turn that never ends (lost renderer, crashed handler) must not keep Escape forever.
function kickWatchdog(): void {
  if (watchdog) clearTimeout(watchdog)
  watchdog = setTimeout(() => {
    watchdog = null
    if (count === 0) return
    // A long research or plan turn, or a long hands-free recording, is still cancellable;
    // only stale holders are released.
    if (hasActiveScope() || [...keepAlive].some((active) => active())) {
      kickWatchdog()
      return
    }
    log('skip', 'escape watchdog: releasing Escape after 60s')
    resetEscape()
  }, WATCHDOG_MS)
}

/** Keeps Escape past the watchdog while `active()` is true. Returns the unsubscribe. */
export function keepEscapeWhile(active: () => boolean): () => void {
  keepAlive.add(active)
  return () => keepAlive.delete(active)
}

/** Takes one reference; pair every call with disarmEscape(). */
export function armEscape(): void {
  count++
  kickWatchdog()
  sync()
}

export function disarmEscape(): void {
  if (count === 0) return
  count--
  sync()
}

/** Idempotent named reference (e.g. 'hud'): holding twice still needs one release. */
export function holdEscape(key: string): void {
  if (holders.has(key)) {
    kickWatchdog()
    return
  }
  holders.add(key)
  armEscape()
}

export function releaseEscape(key: string): void {
  if (holders.delete(key)) disarmEscape()
}

export function resetEscape(): void {
  count = 0
  holders.clear()
  sync()
}
