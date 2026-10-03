// wait_for (T09): waits for a window title, a UI element or on-screen text instead of a fixed
// sleep. Checks run at once, then on every agent change hint (focus / UIA events) and on a poll:
// titles at 4 Hz, elements at 4 Hz for the first second then slower (UIA events wake the loop),
// OCR at 1 Hz (it is the expensive one), until the condition holds or the timeout ends.
import type { WaitForInput } from './tools'

export type WaitCondition = WaitForInput['condition']

export interface WaitProbe {
  title(signal: AbortSignal): Promise<string>
  /** Whether a foreground element with this name (and role) exists now. */
  element(name: string, role: string | undefined, signal: AbortSignal): Promise<boolean>
  /** OCR text of the foreground monitor. */
  screenText(signal: AbortSignal): Promise<string>
  /** Something changed (focus, UIA event) while waiting for `kind`; returns an unsubscribe. */
  onChange?(cb: () => void, kind: WaitCondition['kind']): () => void
  now(): number
}

export const POLL_MS = 250
export const OCR_POLL_MS = 1000
export const MAX_WAIT_MS = 15_000

/** Element poll interval after `elapsed` ms of waiting. */
export function elementPollMs(elapsed: number): number {
  if (elapsed < 1000) return POLL_MS
  if (elapsed < 3000) return 500
  return 1000
}

function pollMs(kind: WaitCondition['kind'], elapsed: number): number {
  if (kind === 'text') return OCR_POLL_MS
  if (kind === 'element') return elementPollMs(elapsed)
  return POLL_MS
}

export interface WaitResult {
  ok: boolean
  ms: number
  /** What matched, or what was last seen at the timeout. */
  detail: string
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function titleMatcher(source: string): (title: string) => boolean {
  try {
    const re = new RegExp(source, 'i')
    return (t) => re.test(t)
  } catch {
    const want = norm(source)
    return (t) => norm(t).includes(want)
  }
}

async function check(
  cond: WaitCondition,
  probe: WaitProbe,
  signal: AbortSignal
): Promise<{ ok: boolean; seen: string }> {
  switch (cond.kind) {
    case 'window_title': {
      const t = await probe.title(signal).catch(() => '')
      return { ok: titleMatcher(cond.value)(t), seen: `title "${t}"` }
    }
    case 'element': {
      const ok = await probe.element(cond.value, cond.role, signal).catch(() => false)
      return { ok, seen: ok ? `"${cond.value}" is there` : `no "${cond.value}" yet` }
    }
    case 'text': {
      const t = await probe.screenText(signal).catch(() => '')
      return { ok: norm(t).includes(norm(cond.value)), seen: 'not on screen yet' }
    }
  }
}

export async function waitFor(
  cond: WaitCondition,
  timeoutMs: number,
  probe: WaitProbe,
  signal: AbortSignal
): Promise<WaitResult> {
  const limit = Math.min(Math.max(0, timeoutMs), MAX_WAIT_MS)
  const t0 = probe.now()
  let wake: (() => void) | null = null
  let changed = false
  const unsubscribe = probe.onChange?.(() => {
    changed = true
    wake?.()
  }, cond.kind)
  try {
    for (;;) {
      signal.throwIfAborted()
      changed = false
      const r = await check(cond, probe, signal)
      signal.throwIfAborted()
      const ms = probe.now() - t0
      if (r.ok) return { ok: true, ms, detail: r.seen }
      if (ms >= limit) return { ok: false, ms, detail: r.seen }
      if (changed) continue
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(done, Math.min(pollMs(cond.kind, ms), Math.max(0, limit - ms)))
        function done(): void {
          clearTimeout(t)
          wake = null
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        function onAbort(): void {
          clearTimeout(t)
          wake = null
          reject(signal.reason)
        }
        wake = done
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  } finally {
    unsubscribe?.()
  }
}
