import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => {
  const m = (await import('./helpers/electron-mock')).electronModule()
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const screen = {
    ...m.screen,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: area, bounds: area, scaleFactor: 1 })
  }
  return { ...m, screen, default: { ...m.default, screen } }
})
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const fake = vi.hoisted(() => {
  const send = vi.fn()
  let visible = false
  const win = {
    webContents: { send, on: vi.fn(), getZoomFactor: () => 1 },
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocused: () => false,
    showInactive: () => {
      visible = true
    },
    hide: () => {
      visible = false
    },
    setBounds: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    moveTop: vi.fn()
  }
  return { send, win }
})
vi.mock('../src/main/windows/factory', () => ({
  createWindow: () => fake.win,
  loadRenderer: vi.fn()
}))

import type { AssistantView } from '../src/shared/channels'
import { bus } from '../src/main/bus'
import { setConfigDir } from '../src/main/config'
import * as assistant from '../src/main/windows/assistant'
import { tempDir } from './helpers/fixtures'

const response = { mode: 'answer', answer: 'x' } as never

function stateSends(): AssistantView[] {
  return fake.send.mock.calls
    .filter((c: unknown[]) => c[0] === 'assistant:state')
    .map((c: unknown[]) => c[1] as AssistantView)
}

describe('assistant bar: streamed deltas', () => {
  let tmp: ReturnType<typeof tempDir>

  beforeEach(() => {
    tmp = tempDir()
    setConfigDir(tmp.dir)
    vi.useFakeTimers()
    assistant.create()
    assistant.open('thinking')
    fake.send.mockClear()
  })
  afterEach(() => {
    assistant.close()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('sends one state for many deltas inside the flush window', () => {
    const parts = Array.from({ length: 20 }, (_, i) => `w${i} `)
    for (const delta of parts) {
      bus.emit({ type: 'query.delta', turnId: 't1', delta })
      vi.advanceTimersByTime(1)
    }
    expect(assistant.state().answer?.markdown).toBe(parts.join(''))
    expect(stateSends()).toHaveLength(0)
    vi.advanceTimersByTime(50)
    const sent = stateSends()
    expect(sent).toHaveLength(1)
    expect(sent[0].answer).toMatchObject({ markdown: parts.join(''), streaming: true })
  })

  it('keeps a long stream to about 20 sends a second', () => {
    for (let i = 0; i < 1000; i++) {
      bus.emit({ type: 'query.delta', turnId: 't1', delta: 'a' })
      vi.advanceTimersByTime(1)
    }
    vi.advanceTimersByTime(50)
    expect(stateSends().length).toBeLessThanOrEqual(21)
    expect(assistant.state().answer?.markdown).toBe('a'.repeat(1000))
  })

  it('done sends the rest at once, with the whole text', () => {
    bus.emit({ type: 'query.started', turnId: 't1', prompt: 'hi' })
    for (const delta of ['Hello', ' there', ' friend.']) {
      bus.emit({ type: 'query.delta', turnId: 't1', delta })
    }
    const before = stateSends().length
    bus.emit({ type: 'query.done', turnId: 't1', response })
    const sent = stateSends()
    expect(sent.length).toBe(before + 1)
    expect(sent.at(-1)!.answer).toMatchObject({ markdown: 'Hello there friend.', streaming: false })
    vi.advanceTimersByTime(100)
    expect(stateSends().length).toBe(before + 1)
  })

  it('a failure and other patches are not held back', () => {
    bus.emit({ type: 'query.delta', turnId: 't1', delta: 'Part' })
    assistant.setStatus('thinking', 'Still going')
    expect(stateSends().at(-1)).toMatchObject({ statusText: 'Still going' })
    expect(stateSends().at(-1)!.answer?.markdown).toBe('Part')
    bus.emit({ type: 'query.failed', turnId: 't1', error: 'Network down' })
    expect(stateSends().at(-1)).toMatchObject({ phase: 'error' })
    const n = stateSends().length
    vi.advanceTimersByTime(100)
    expect(stateSends().length).toBe(n)
  })

  it('close drops a pending stream send', () => {
    bus.emit({ type: 'query.delta', turnId: 't1', delta: 'Part' })
    assistant.close()
    const n = stateSends().length
    vi.advanceTimersByTime(100)
    expect(stateSends().length).toBe(n)
    expect(stateSends().at(-1)!.visible).toBe(false)
  })
})
