import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

interface FakeWin {
  visible: boolean
  sent: [string, unknown][]
  moveTop: ReturnType<typeof vi.fn>
  load: () => void
}
const wins: FakeWin[] = []

vi.mock('../../src/main/windows/factory', () => ({
  createWindow: () => {
    let onLoad = (): void => {}
    const w: FakeWin & Record<string, unknown> = {
      visible: false,
      sent: [],
      moveTop: vi.fn(),
      load: () => onLoad(),
      webContents: {
        send: (ch: string, payload: unknown) => w.sent.push([ch, payload]),
        on: (ev: string, fn: () => void) => {
          if (ev === 'did-finish-load') onLoad = fn
        }
      },
      isVisible: () => w.visible,
      isDestroyed: () => false,
      showInactive: () => (w.visible = true),
      hide: () => (w.visible = false),
      destroy: () => {},
      setBounds: () => {},
      setAlwaysOnTop: () => {},
      setIgnoreMouseEvents: () => {},
      setFocusable: () => {},
      focus: () => {}
    }
    wins.push(w)
    return w
  },
  loadRenderer: () => {}
}))
vi.mock('../../src/main/windows/registry', () => ({
  onBroadcast: () => {},
  registerWindowSet: () => {}
}))
vi.mock('../../src/main/config', () => ({
  loadConfig: () => ({ buddy: { enabled: false, followCursor: false } })
}))

import type { ScreenScene } from '../../src/shared/events'
import * as layer from '../../src/main/windows/screen-layer'

function lastScene(w: FakeWin): ScreenScene {
  const renders = w.sent.filter(([ch]) => ch === 'screen:render')
  return renders[renders.length - 1][1] as ScreenScene
}

describe('screen layer scene', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    layer.create()
    wins.forEach((w) => w.load())
    layer.clear()
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the guide boxes when the pointer arrives (audit #13)', () => {
    const w = wins[0]
    layer.setHighlights([
      { label: 'Compose', bbox: { x: 10, y: 10, w: 80, h: 30 } },
      { label: 'Send', bbox: { x: 200, y: 10, w: 80, h: 30 } }
    ])
    layer.setPointer({ x: 50, y: 25, text: '1/2: Compose' })
    const s = lastScene(w)
    expect(s.highlights.map((h) => h.id)).toEqual(['h0', 'h1'])
    expect(s.buddy).toMatchObject({ to: { x: 50, y: 25 }, label: '1/2: Compose', mode: 'point' })
  })

  it('a single guide step keeps its id, so the ring morphs between steps', () => {
    const w = wins[0]
    layer.setHighlights([{ label: 'A', bbox: { x: 10, y: 10, w: 80, h: 30 } }])
    const a = lastScene(w).highlights[0]
    layer.setHighlights([{ label: 'B', bbox: { x: 300, y: 300, w: 80, h: 30 } }])
    const b = lastScene(w).highlights[0]
    expect(a.id).toBe(b.id)
    expect(b.rect.x).toBe(300)
  })

  it('clears a locate spotlight after 6s', () => {
    const w = wins[0]
    layer.setLocate([{ label: 'x', bbox: { x: 10, y: 10, w: 80, h: 30 } }])
    expect(lastScene(w).highlights).toHaveLength(1)
    vi.advanceTimersByTime(6100)
    expect(lastScene(w).highlights).toHaveLength(0)
  })

  it('shows failure for 1.5s', () => {
    const w = wins[0]
    layer.flashFailure({ x: 1, y: 1, w: 10, h: 10 })
    expect(lastScene(w).highlights[0].style).toBe('failure')
    vi.advanceTimersByTime(1600)
    expect(lastScene(w).highlights).toHaveLength(0)
  })

  it('does not raise the window on every dwell tick', () => {
    const w = wins[0]
    layer.setHighlights([{ label: 'A', bbox: { x: 10, y: 10, w: 80, h: 30 } }])
    const raises = w.moveTop.mock.calls.length
    for (let i = 0; i < 10; i++) layer.dwell({ x: 100, y: 100, progress: i / 10, active: true })
    expect(w.moveTop.mock.calls.length).toBe(raises)
  })
})
