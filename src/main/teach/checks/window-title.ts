// window-title: the foreground window title matches a regex (case-insensitive). Polls the
// agent's active_window at 2 Hz while the step is active.
import type { CheckResult } from '../ports'
import type { CheckContext, CheckHandle } from './types'
import { poll, settleable } from './types'

export const TITLE_POLL_MS = 500

export function titleRegex(source: string): RegExp {
  try {
    return new RegExp(source, 'i')
  } catch {
    return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

export function start(spec: { regex: string }, ctx: CheckContext): CheckHandle {
  const re = titleRegex(spec.regex)
  const r = settleable()
  const current = async (): Promise<CheckResult> => {
    const w = await ctx.ports.window.activeWindow().catch(() => null)
    if (!w) return 'unknown'
    return re.test(w.title) ? 'pass' : 'fail'
  }
  const p = poll(ctx.clock, TITLE_POLL_MS, async () => {
    if ((await current()) === 'pass') {
      p.stop()
      r.settle('pass')
    }
  })
  return {
    result: r.promise,
    evaluate: current,
    cancel: () => {
      p.stop()
      r.settle('unknown')
    }
  }
}
