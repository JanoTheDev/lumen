import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { realClock } from '../../src/main/a11y/timings'
import {
  combineAll,
  combineAny,
  newBudget,
  startCheck,
  type CheckContext
} from '../../src/main/teach/checks'
import { normalizeCombo } from '../../src/main/teach/checks/keypress'
import { MAX_CALLS_PER_STEP } from '../../src/main/teach/checks/vision'
import type { CheckSpec, LessonStep } from '../../src/main/teach/lesson'
import { noopPorts, type Ports, type UiaEvent } from '../../src/main/teach/ports'

const STEP: LessonStep = {
  id: 's',
  say: 'Do it.',
  target: null,
  check: { type: 'manual' },
  hints: []
}

function ctx(ports: Partial<Ports>, logs: string[] = []): CheckContext {
  return {
    ports: noopPorts(ports),
    clock: realClock,
    step: STEP,
    budget: newBudget(),
    log: (m) => logs.push(m)
  }
}

/** Resolves to the result if it settled by now, else 'pending'. */
async function peek(p: Promise<string>): Promise<string> {
  let v = 'pending'
  void p.then((r) => (v = r))
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return v
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function tickFor(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('manual', () => {
  it('passes only on evaluate ("done")', async () => {
    const h = startCheck({ type: 'manual' }, ctx({}))
    await tickFor(10_000)
    const pending = peek(h.result)
    await tickFor(1)
    expect(await pending).toBe('pending')
    expect(await h.evaluate()).toBe('pass')
  })
})

describe('window-title', () => {
  it('polls the active window at 2 Hz and matches the regex case-insensitively', async () => {
    let title = 'Desktop'
    const activeWindow = vi.fn(async () => ({ title }))
    const h = startCheck(
      { type: 'window-title', regex: '^settings$' },
      ctx({ window: { activeWindow } })
    )
    await tickFor(1000)
    expect(activeWindow.mock.calls.length).toBeLessThanOrEqual(3)
    expect(await h.evaluate()).toBe('fail')
    title = 'Settings'
    await tickFor(600)
    expect(await h.result).toBe('pass')
    const calls = activeWindow.mock.calls.length
    await tickFor(5000)
    expect(activeWindow.mock.calls.length).toBe(calls)
  })

  it('stops polling on cancel', async () => {
    const activeWindow = vi.fn(async () => ({ title: 'x' }))
    const h = startCheck({ type: 'window-title', regex: 'y' }, ctx({ window: { activeWindow } }))
    await tickFor(600)
    h.cancel()
    const calls = activeWindow.mock.calls.length
    await tickFor(5000)
    expect(activeWindow.mock.calls.length).toBe(calls)
    expect(await h.result).toBe('unknown')
  })
})

function fakeUia(): {
  emit(e: UiaEvent): void
  kinds: string[][]
  unsubscribed: number
  port: Ports['uia']
  found: Awaited<ReturnType<Ports['uia']['find']>>
} {
  const subs = new Set<(e: UiaEvent) => void>()
  const self = {
    kinds: [] as string[][],
    unsubscribed: 0,
    found: [] as Awaited<ReturnType<Ports['uia']['find']>>,
    emit: (e: UiaEvent) => subs.forEach((s) => s(e)),
    port: {
      find: async () => self.found,
      subscribe: (kinds: string[], cb: (e: UiaEvent) => void) => {
        self.kinds.push(kinds)
        subs.add(cb)
        return () => {
          self.unsubscribed++
          subs.delete(cb)
        }
      }
    } as Ports['uia']
  }
  return self
}

const node = (name: string, role: string, extra: object = {}): never =>
  ({
    id: 'e1',
    name,
    role,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    monitorId: 0,
    enabled: true,
    patterns: [],
    ...extra
  }) as never

describe('uia-event', () => {
  it('passes on a matching event; name and role ignore case', async () => {
    const uia = fakeUia()
    const spec: CheckSpec = {
      type: 'uia-event',
      event: 'selected',
      match: { name: 'System', role: 'ListItem' }
    }
    const h = startCheck(spec, ctx({ uia: uia.port }))
    expect(uia.kinds[0]).toEqual(['selected', 'focused'])
    uia.emit({ kind: 'focused', element: { name: 'Bluetooth', role: 'listitem' } })
    expect(await peek(h.result)).toBe('pending')
    uia.emit({ kind: 'focused', element: { name: 'system', role: 'listitem' } })
    expect(await h.result).toBe('pass')
    h.cancel()
    expect(uia.unsubscribed).toBe(1)
  })

  it('matches a value regex', async () => {
    const uia = fakeUia()
    const spec: CheckSpec = {
      type: 'uia-event',
      event: 'value',
      match: { name: 'Scale', value: { regex: '^1[2-9]\\d%' } }
    }
    const h = startCheck(spec, ctx({ uia: uia.port }))
    uia.emit({ kind: 'value', element: { name: 'Scale', value: '100%' } })
    expect(await peek(h.result)).toBe('pending')
    uia.emit({ kind: 'value', element: { name: 'Scale', value: '125% (Recommended)' } })
    expect(await h.result).toBe('pass')
  })

  it('evaluate reads focus now; invoked cannot be read back', async () => {
    const uia = fakeUia()
    const focused: CheckSpec = { type: 'uia-event', event: 'focused', match: { name: 'Scale' } }
    const h = startCheck(focused, ctx({ uia: uia.port }))
    expect(await h.evaluate()).toBe('unknown')
    uia.found = [node('Scale', 'combobox')]
    expect(await h.evaluate()).toBe('fail')
    uia.found = [node('Scale', 'combobox', { focused: true })]
    expect(await h.evaluate()).toBe('pass')
    const inv = startCheck(
      { type: 'uia-event', event: 'invoked', match: { name: 'Display' } },
      ctx({ uia: uia.port })
    )
    expect(await inv.evaluate()).toBe('unknown')
  })

  it('window-opened evaluate: a window role or the foreground title, never a same-named button', async () => {
    const uia = fakeUia()
    let title = 'OBS 30.2.3'
    const window = { activeWindow: async () => ({ title }) }
    const spec: CheckSpec = {
      type: 'uia-event',
      event: 'window-opened',
      match: { name: 'Settings' }
    }
    const h = startCheck(spec, ctx({ uia: uia.port, window }))
    uia.found = [node('Settings', 'button')]
    expect(await h.evaluate()).toBe('fail')
    uia.found = [node('Settings', 'dialog')]
    expect(await h.evaluate()).toBe('pass')
    uia.found = []
    title = 'Settings'
    expect(await h.evaluate()).toBe('pass')
    const pane = startCheck(
      { type: 'uia-event', event: 'window-opened', match: { name: 'Settings', role: 'Pane' } },
      ctx({ uia: uia.port, window })
    )
    expect(await pane.evaluate()).toBe('fail')
    uia.found = [node('Settings', 'pane')]
    expect(await pane.evaluate()).toBe('pass')
  })
})

describe('keypress', () => {
  it('normalizes combos', () => {
    expect(normalizeCombo('Shift+Control+a')).toBe('ctrl+shift+a')
    expect(normalizeCombo('Windows + I')).toBe('win+i')
    expect(normalizeCombo('Win+I')).toBe(normalizeCombo('win+i'))
  })

  it('passes on the observed combo only', async () => {
    let cb: ((c: string) => void) | null = null
    const keys = {
      available: () => true,
      onCombo: (fn: (c: string) => void) => {
        cb = fn
        return () => (cb = null)
      }
    }
    const h = startCheck({ type: 'keypress', combo: 'Ctrl+S' }, ctx({ keys }))
    cb!('Ctrl+A')
    expect(await h.evaluate()).toBe('unknown')
    cb!('control+s')
    expect(await h.result).toBe('pass')
    h.cancel()
    expect(cb).toBeNull()
  })
})

describe('bridge', () => {
  it('polls at 1 Hz until pass', async () => {
    const answers = ['fail', 'fail', 'pass'] as const
    let i = 0
    const query = vi.fn(async () => answers[Math.min(i++, 2)])
    const h = startCheck(
      { type: 'bridge', app: 'blender', expect: { mode: 'EDIT' } },
      ctx({ bridge: { query } })
    )
    await tickFor(2500)
    expect(await h.result).toBe('pass')
    expect(query).toHaveBeenCalledWith('blender', { mode: 'EDIT' }, expect.anything())
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('stops polling when no bridge is connected but still answers evaluate', async () => {
    const query = vi.fn(async () => 'unknown' as const)
    const h = startCheck(
      { type: 'bridge', app: 'obs', expect: { outputActive: true } },
      ctx({ bridge: { query } })
    )
    await tickFor(5000)
    expect(query).toHaveBeenCalledTimes(1)
    expect(await h.evaluate()).toBe('unknown')
  })
})

/** A screen whose picture is a number; frames differ when the numbers differ. */
function fakeScreen(): { picture: number; port: Ports['screen']; captures: number } {
  let n = 0
  const self = {
    picture: 0,
    captures: 0,
    port: {
      capture: async () => {
        self.captures++
        return { id: `f${++n}`, sig: self.picture }
      },
      diff: (a: { sig?: unknown }, b: { sig?: unknown }) => (a.sig === b.sig ? 0 : 0.3),
      emitScene: () => {},
      emitState: () => {}
    } as Ports['screen']
  }
  return self
}

describe('vision', () => {
  const spec: CheckSpec = { type: 'vision', prompt: 'Is the menu open?' }

  it('makes no calls while the screen is unchanged', async () => {
    const screen = fakeScreen()
    const vision = vi.fn(async () => 'pass' as const)
    const logs: string[] = []
    startCheck(spec, ctx({ screen: screen.port, verify: { vision } }, logs))
    await tickFor(30_000)
    expect(vision).not.toHaveBeenCalled()
    expect(screen.captures).toBeGreaterThan(10)
  })

  it('calls once at a settle (changed, then still ≥ 700 ms) and passes', async () => {
    const screen = fakeScreen()
    const vision = vi.fn(async () => 'pass' as const)
    const h = startCheck(spec, ctx({ screen: screen.port, verify: { vision } }))
    await tickFor(1000)
    screen.picture = 1
    await tickFor(600)
    expect(vision).not.toHaveBeenCalled()
    await tickFor(1500)
    expect(vision).toHaveBeenCalledTimes(1)
    expect(vision.mock.calls[0][0]).toBe('Is the menu open?')
    expect(await h.result).toBe('pass')
  })

  it('a screen that returns to the start picture costs nothing', async () => {
    const screen = fakeScreen()
    const vision = vi.fn(async () => 'fail' as const)
    startCheck(spec, ctx({ screen: screen.port, verify: { vision } }))
    await tickFor(1000)
    screen.picture = 1
    await tickFor(500)
    screen.picture = 0
    await tickFor(5000)
    expect(vision).not.toHaveBeenCalled()
  })

  it('keeps ≥ 3 s between calls and stops at the per-step cap', async () => {
    const screen = fakeScreen()
    const vision = vi.fn(async () => 'fail' as const)
    const c = ctx({ screen: screen.port, verify: { vision } })
    const h = startCheck(spec, c)
    const times: number[] = []
    vision.mockImplementation(async () => {
      times.push(Date.now())
      return 'fail'
    })
    for (let i = 1; i <= 20; i++) {
      screen.picture = i
      await tickFor(2500)
    }
    expect(vision).toHaveBeenCalledTimes(MAX_CALLS_PER_STEP)
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(3000)
    // "done" still asks after the cap.
    vision.mockResolvedValue('pass')
    await tickFor(3000)
    expect(await h.evaluate()).toBe('pass')
    expect(c.budget.calls).toBe(MAX_CALLS_PER_STEP + 1)
  })

  it('"done" within 3 s of a call reuses its answer', async () => {
    const screen = fakeScreen()
    const vision = vi.fn(async () => 'fail' as const)
    const h = startCheck(spec, ctx({ screen: screen.port, verify: { vision } }))
    await tickFor(10)
    expect(await h.evaluate()).toBe('fail')
    expect(await h.evaluate()).toBe('fail')
    expect(vision).toHaveBeenCalledTimes(1)
  })

  it('without a before-frame it never calls and "done" is unknown', async () => {
    const vision = vi.fn(async () => 'pass' as const)
    const h = startCheck(spec, ctx({ verify: { vision } }))
    await tickFor(10_000)
    expect(await h.evaluate()).toBe('unknown')
    expect(vision).not.toHaveBeenCalled()
  })
})

describe('combinators', () => {
  it('combine results', () => {
    expect(combineAny(['fail', 'pass'])).toBe('pass')
    expect(combineAny(['fail', 'unknown'])).toBe('fail')
    expect(combineAny(['unknown', 'unknown'])).toBe('unknown')
    expect(combineAll(['pass', 'pass'])).toBe('pass')
    expect(combineAll(['pass', 'unknown'])).toBe('unknown')
    expect(combineAll(['pass', 'fail'])).toBe('fail')
  })

  it('anyOf passes on the first child; allOf needs every child', async () => {
    let title = 'x'
    const window = { activeWindow: async () => ({ title }) }
    let cb: ((c: string) => void) | null = null
    const keys = {
      available: () => true,
      onCombo: (fn: (c: string) => void) => {
        cb = fn
        return () => {}
      }
    }
    const any = startCheck(
      {
        type: 'anyOf',
        checks: [
          { type: 'window-title', regex: '^Settings$' },
          { type: 'keypress', combo: 'Win+I' }
        ]
      },
      ctx({ window, keys })
    )
    cb!('Win+I')
    expect(await any.result).toBe('pass')

    const all = startCheck(
      {
        type: 'allOf',
        checks: [
          { type: 'window-title', regex: '^Settings$' },
          { type: 'keypress', combo: 'Win+I' }
        ]
      },
      ctx({ window, keys })
    )
    cb!('Win+I')
    await tickFor(1000)
    expect(await peek(all.result)).toBe('pending')
    expect(await all.evaluate()).toBe('fail')
    title = 'Settings'
    await tickFor(600)
    expect(await all.result).toBe('pass')
  })
})
