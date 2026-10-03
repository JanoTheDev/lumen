// Startup makes no screen layer unless the buddy is on, and no Home window until a moment
// after the bar loaded; first use (or Home's first open) creates them.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  return {
    screen: {
      getAllDisplays: () => [{ id: 1, bounds, workArea: bounds, scaleFactor: 1 }],
      getDisplayNearestPoint: () => ({ id: 1, bounds, workArea: bounds, scaleFactor: 1 }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: () => {}
    },
    globalShortcut: { register: () => true, unregister: () => {} }
  }
})

const h = vi.hoisted(() => ({
  made: 0,
  cfg: { buddy: { enabled: false, followCursor: false }, a11y: { uiScale: 1 }, ui: {} }
}))

vi.mock('../../src/main/windows/factory', () => ({
  createWindow: () => {
    h.made++
    return {
      webContents: { send: () => {}, on: () => {}, once: () => {}, isLoading: () => false },
      isVisible: () => false,
      isDestroyed: () => false,
      on: () => {},
      show: () => {},
      showInactive: () => {},
      focus: () => {},
      hide: () => {},
      destroy: () => {},
      setBounds: () => {},
      setAlwaysOnTop: () => {},
      setIgnoreMouseEvents: () => {},
      setFocusable: () => {}
    }
  },
  loadRenderer: () => {}
}))
vi.mock('../../src/main/windows/registry', () => ({
  onBroadcast: () => {},
  registerWindowSet: () => {},
  clampScale: (n: number) => n,
  live: (w: unknown) => w,
  registerWindow: () => {},
  sendTo: () => {}
}))
vi.mock('../../src/main/windows/settings', () => ({ themeBackground: () => '#000' }))
vi.mock('../../src/main/ipc/settings', () => ({ onConfigPatched: () => {} }))
vi.mock('../../src/main/config', () => ({ loadConfig: () => h.cfg }))
vi.mock('../../src/main/agent/subscriptions', () => ({ mouseEvents: { want: vi.fn() } }))

beforeEach(() => {
  vi.resetModules()
  h.made = 0
  h.cfg.buddy.enabled = false
})

describe('screen layer at start', () => {
  it('makes no layer until something is drawn', async () => {
    const layer = await import('../../src/main/windows/screen-layer')
    layer.start()
    layer.setScene({ highlights: [], buddy: undefined })
    layer.clear()
    expect(h.made).toBe(0)
    layer.setHighlights([{ label: 'Send', bbox: { x: 1, y: 1, w: 10, h: 10 } }])
    expect(h.made).toBeGreaterThan(0)
  })

  it('makes the layer at start when the buddy is on, and when a voice turn starts', async () => {
    h.cfg.buddy.enabled = true
    const layer = await import('../../src/main/windows/screen-layer')
    layer.start()
    expect(h.made).toBeGreaterThan(0)
    h.cfg.buddy.enabled = false
    vi.resetModules()
    h.made = 0
    const again = await import('../../src/main/windows/screen-layer')
    const { bus } = await import('../../src/main/bus')
    again.start()
    expect(h.made).toBe(0)
    bus.emit({ type: 'voice.started', handsFree: false })
    expect(h.made).toBeGreaterThan(0)
  })
})

describe('home window', () => {
  it('is made a moment after start, or at once when opened first', async () => {
    vi.useFakeTimers()
    try {
      const home = await import('../../src/main/windows/home')
      home.createSoon(null, 1500)
      expect(h.made).toBe(0)
      vi.advanceTimersByTime(1500)
      expect(h.made).toBe(1)
      vi.resetModules()
      h.made = 0
      const fresh = await import('../../src/main/windows/home')
      fresh.createSoon(null, 1500)
      fresh.show()
      expect(h.made).toBe(1)
      vi.advanceTimersByTime(1500)
      expect(h.made).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
