import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

interface FakeWin {
  visible: boolean
  sent: [string, unknown][]
  load: () => void
}
const wins: FakeWin[] = []

vi.mock('../../src/main/windows/factory', () => ({
  createWindow: () => {
    let onLoad = (): void => {}
    const w: FakeWin & Record<string, unknown> = {
      visible: false,
      sent: [],
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
      moveTop: () => {}
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
const h = vi.hoisted(() => ({ cfg: { buddy: { enabled: true, followCursor: true } } }))
vi.mock('../../src/main/config', () => ({ loadConfig: () => h.cfg }))
vi.mock('../../src/main/agent/subscriptions', () => ({ mouseEvents: { want: () => {} } }))

import { setDisplays } from '../helpers/electron-mock'
import { DUAL_150_100 } from '../helpers/displays'
import * as layer from '../../src/main/windows/screen-layer'

const count = (w: FakeWin, ch: string): number => w.sent.filter(([c]) => c === ch).length
const payloads = (w: FakeWin, ch: string): unknown[] =>
  w.sent.filter(([c]) => c === ch).map(([, p]) => p)

describe('screen layer push volume (12 T3, T10)', () => {
  beforeAll(() => {
    setDisplays(DUAL_150_100)
    layer.create()
    wins.forEach((w) => w.load())
  })
  beforeEach(() => {
    layer.clear()
    for (const w of wins) w.sent.length = 0
  })

  it('has one layer per display', () => {
    expect(wins).toHaveLength(2)
  })

  it('drops cursor moves under 1 px but keeps slow drift', () => {
    const [a] = wins
    layer.onCursorMoved({ x: 100, y: 100 })
    const start = count(a, 'screen:cursor')
    for (let i = 1; i <= 100; i++) layer.onCursorMoved({ x: 100 + i * 0.25, y: 100 })
    expect(count(a, 'screen:cursor') - start).toBe(25)
    expect(payloads(a, 'screen:cursor').at(-1)).toEqual({ x: 125, y: 100 })
  })

  it('still sends a sub-pixel move that crosses to another display', () => {
    const [a, b] = wins
    layer.onCursorMoved({ x: 1919.6, y: 500 })
    const before = count(b, 'screen:cursor')
    layer.onCursorMoved({ x: 1920.2, y: 500 })
    expect(count(b, 'screen:cursor')).toBe(before + 1)
    const p = payloads(b, 'screen:cursor').at(-1) as { x: number; y: number }
    expect(p.x).toBeCloseTo(0.2)
    expect(payloads(a, 'screen:cursor').at(-1)).toBeNull()
  })

  it('sends the inactive dwell frame to other layers only once', () => {
    const [a, b] = wins
    layer.dwell({ x: 100, y: 100, progress: 0, active: true })
    for (let i = 1; i <= 50; i++) layer.dwell({ x: 100, y: 100, progress: i / 50, active: true })
    expect(count(a, 'screen:dwell')).toBe(51)
    expect(count(b, 'screen:dwell')).toBeLessThanOrEqual(1)
    const bSent = count(b, 'screen:dwell')

    // Moving to the other display: A gets one inactive frame on the transition.
    for (let i = 0; i < 50; i++) layer.dwell({ x: 2000, y: 100, progress: i / 50, active: true })
    expect(count(b, 'screen:dwell')).toBe(bSent + 50)
    expect(count(a, 'screen:dwell')).toBe(52)
    expect(payloads(a, 'screen:dwell').at(-1)).toMatchObject({ active: false })

    // Parking the ring off-screen turns B's ring off once.
    layer.setDwellEnabled(false)
    layer.setDwellEnabled(false)
    expect(count(b, 'screen:dwell')).toBe(bSent + 51)
    expect(payloads(b, 'screen:dwell').at(-1)).toMatchObject({ active: false })
    expect(count(a, 'screen:dwell')).toBe(52)
  })
})
