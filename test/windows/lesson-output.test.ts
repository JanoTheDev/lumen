import { beforeEach, describe, expect, it, vi } from 'vitest'

const bar = vi.hoisted(() => {
  const b = {
    confirm: null as null | { actionId: string; summary: string },
    resolve: null as null | ((ok: boolean) => void),
    n: 0,
    requestConfirm: vi.fn((c: { summary: string }) => {
      b.resolve?.(false)
      const actionId = `a${++b.n}`
      b.confirm = { actionId, summary: c.summary }
      return new Promise<boolean>((r) => (b.resolve = r))
    }),
    answer(ok: boolean) {
      const r = b.resolve
      b.resolve = null
      b.confirm = null
      r?.(ok)
    },
    dropConfirm: vi.fn(() => b.answer(false)),
    close: vi.fn(() => b.answer(false)),
    confirmPending: () => !!b.resolve,
    state: () => ({ confirm: b.confirm ?? undefined })
  }
  return b
})
vi.mock('../../src/main/windows/assistant', () => bar)
vi.mock('../../src/main/windows/screen-layer', () => ({ setScene: vi.fn() }))
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn(), hideStatus: vi.fn() }))

import { bus } from '../../src/main/bus'
import { installLessonOutput } from '../../src/main/windows/lesson'

installLessonOutput()

const step = { phase: 'step', statusText: 'Click File' } as never
const offer = {
  phase: 'step',
  statusText: 'Want me to do it?',
  confirm: { summary: 'Do it', risk: 'low' }
} as never

describe('lesson bar output (review a11y #3)', () => {
  beforeEach(() => {
    bar.answer(false)
    bar.dropConfirm.mockClear()
    bar.close.mockClear()
    bar.requestConfirm.mockClear()
  })

  it('a lesson step leaves another feature’s confirm alone', async () => {
    const other = bar.requestConfirm({ summary: 'Allow Claude Code to run npm test?' })
    const seen = vi.fn()
    void other.then(seen)
    bus.emit({ type: 'lesson.state', state: step })
    await Promise.resolve()
    expect(bar.close).not.toHaveBeenCalled()
    expect(bar.dropConfirm).not.toHaveBeenCalled()
    expect(bar.confirmPending()).toBe(true)
    expect(seen).not.toHaveBeenCalled()
  })

  it('a do-it offer does not replace another feature’s confirm', () => {
    bar.requestConfirm({ summary: 'Allow?' })
    bar.requestConfirm.mockClear()
    bus.emit({ type: 'lesson.state', state: offer })
    expect(bar.requestConfirm).not.toHaveBeenCalled()
    expect(bar.confirm?.summary).toBe('Allow?')
  })

  it('the next step drops the lesson’s own offer', () => {
    bus.emit({ type: 'lesson.state', state: offer })
    expect(bar.confirm?.summary).toBe('Want me to do it?')
    bus.emit({ type: 'lesson.state', state: step })
    expect(bar.dropConfirm).toHaveBeenCalledTimes(1)
    expect(bar.confirmPending()).toBe(false)
  })
})
