// One installed Lumen at a time, so a wake-up task (schtasks.ts) that starts Lumen while it is
// open hands its automation to the open Lumen and quits. Dev and the portable build keep the
// old behaviour (no lock), so a dev run never closes because the installed Lumen is open.
import { app } from 'electron'
import { autostartSupported } from '../first-run/autostart'
import { automationIdFromArgv } from './schtasks'

let handler: ((id: string) => void) | null = null
let plainLaunch: (() => void) | null = null
const waiting: string[] = []

function deliver(id: string): void {
  if (handler) handler(id)
  else if (waiting.length < 10) waiting.push(id)
}

/**
 * Call before the app is ready. False: another installed Lumen is running and got this
 * process's automation run (if any); quit at once.
 */
export function claimAutomationInstance(argv: readonly string[] = process.argv): boolean {
  const own = automationIdFromArgv(argv)
  if (own) deliver(own)
  if (!autostartSupported()) return true
  const got = app.requestSingleInstanceLock({ runAutomation: own })
  if (!got) return false
  app.on('second-instance', (_e, otherArgv, _cwd, data) => {
    const fromData = (data as { runAutomation?: unknown } | null)?.runAutomation
    const id =
      typeof fromData === 'string' ? automationIdFromArgv(['--run-automation', fromData]) : null
    const run = id ?? automationIdFromArgv(otherArgv)
    if (run) deliver(run)
    // Lumen started again by hand: show the open one instead of a second copy.
    else if (!otherArgv.includes('--hidden')) plainLaunch?.()
  })
  return true
}

/** Runs asked for that wait for onAutomationRequest (read before the scheduler starts). */
export function waitingAutomationRequests(): string[] {
  return [...waiting]
}

/** The automation runs asked for so far, then every later one. */
export function onAutomationRequest(fn: (id: string) => void): void {
  handler = fn
  for (const id of waiting.splice(0)) fn(id)
}

/** Lumen was started again by hand while it runs (installed build). */
export function onSecondLaunch(fn: () => void): void {
  plainLaunch = fn
}
