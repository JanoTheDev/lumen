import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

vi.mock('../../src/main/agent/commands', () => ({
  audioOutput: vi.fn(),
  audioSetVolume: vi.fn(),
  pttMouse: vi.fn()
}))
vi.mock('../../src/main/windows/assistant', () => ({ placeNear: vi.fn() }))
vi.mock('../../src/main/ipc/settings', () => ({ onConfigPatched: vi.fn() }))

import { Ducker, type DuckIo, type DuckState, type DuckStore } from '../../src/main/speech/duck'
import { pillAnchor } from '../../src/main/speech/caret-pill'
import { wantedPttButton } from '../../src/main/speech/mouse-ptt'
import { pillBounds } from '../../src/main/windows/pill-place'
import { DEFAULT_CONFIG_V2 } from '../../src/shared/config'

function memStore(initial: DuckState | null = null): DuckStore & { value: DuckState | null } {
  const s = {
    value: initial,
    load: () => s.value,
    save: (v: DuckState) => {
      s.value = v
    },
    clear: () => {
      s.value = null
    }
  }
  return s
}

function fakeIo(volume: number, muted = false): DuckIo & { volume: number; sets: number[] } {
  const io = {
    volume,
    sets: [] as number[],
    read: async () => ({ muted, volume: io.volume }),
    set: async (v: number) => {
      io.sets.push(v)
      io.volume = v
    }
  }
  return io
}

describe('media ducking (04 T47)', () => {
  it('ducks and restores, saving the original first', async () => {
    const io = fakeIo(0.6)
    const store = memStore()
    const d = new Ducker(io, store)
    await d.duck()
    expect(io.volume).toBeCloseTo(0.18)
    expect(store.value).toEqual({ original: 0.6, ducked: 0.18 })
    await d.duck()
    expect(io.sets).toHaveLength(1)
    await d.restore()
    expect(io.volume).toBe(0.6)
    expect(store.value).toBeNull()
    expect(d.ducked).toBe(false)
  })

  it('a restore asked while ducking runs after it', async () => {
    const io = fakeIo(0.5)
    const d = new Ducker(io, memStore())
    const a = d.duck()
    const b = d.restore()
    await Promise.all([a, b])
    expect(io.volume).toBe(0.5)
  })

  it('leaves a volume the user changed meanwhile', async () => {
    const io = fakeIo(0.5)
    const store = memStore()
    const d = new Ducker(io, store)
    await d.duck()
    io.volume = 0.9
    await d.restore()
    expect(io.volume).toBe(0.9)
    expect(store.value).toBeNull()
  })

  it('muted or nearly silent output is not touched', async () => {
    for (const io of [fakeIo(0.6, true), fakeIo(0.05)]) {
      const store = memStore()
      await new Ducker(io, store).duck()
      expect(io.sets).toHaveLength(0)
      expect(store.value).toBeNull()
    }
  })

  it('a crash leftover is restored at the next start', async () => {
    const io = fakeIo(0.15)
    const store = memStore({ original: 0.5, ducked: 0.15 })
    await new Ducker(io, store).restore()
    expect(io.volume).toBe(0.5)
    expect(store.value).toBeNull()
  })

  it('a failed restore keeps the state to try again', async () => {
    const io = fakeIo(0.5)
    const store = memStore()
    const d = new Ducker(io, store)
    await d.duck()
    const read = io.read
    io.read = async () => {
      throw new Error('agent gone')
    }
    await expect(d.restore()).rejects.toThrow('agent gone')
    expect(d.ducked).toBe(true)
    expect(store.value).not.toBeNull()
    io.read = read
    await d.restore()
    expect(io.volume).toBe(0.5)
  })
})

describe('caret pill (04 T47)', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 }
  const layout = { width: 688, height: 624, bottomPad: 16, pillHeight: 52, gap: 10 }

  it('puts the card just below the caret', () => {
    const b = pillBounds({ x: 800, y: 300, width: 2, height: 20 }, work, layout)
    // Card bottom = window bottom - pad = caret bottom + gap + pill height.
    expect(b.y + b.height - layout.bottomPad).toBe(300 + 20 + 10 + 52)
    expect(b.x + b.width / 2).toBe(801)
  })

  it('goes above the caret near the bottom and stays on screen sideways', () => {
    const b = pillBounds({ x: 10, y: 1000, width: 2, height: 20 }, work, layout)
    expect(b.y + b.height - layout.bottomPad).toBe(1000 - 10)
    expect(b.x).toBe(0)
    const r = pillBounds({ x: 1910, y: 300, width: 2, height: 20 }, work, layout)
    expect(r.x + r.width).toBe(1920)
  })

  it('anchors on the caret, else a one-line field, never a whole document', () => {
    expect(pillAnchor({ caret: { x: 5, y: 6, w: 1, h: 18 } })).toEqual({ x: 5, y: 6, w: 1, h: 18 })
    expect(pillAnchor({ caret: null, rect: { x: 100, y: 50, w: 400, h: 30 } })).toEqual({
      x: 108,
      y: 50,
      w: 0,
      h: 30
    })
    expect(pillAnchor({ rect: { x: 0, y: 0, w: 1200, h: 900 } })).toBeNull()
    expect(pillAnchor({ caret: { x: 'a' } })).toBeNull()
    expect(pillAnchor(null)).toBeNull()
  })
})

describe('mouse push-to-talk (04 T48)', () => {
  it('only while dictation is on and a button is chosen', () => {
    const d = DEFAULT_CONFIG_V2.dictation
    expect(wantedPttButton({ dictation: d })).toBe('')
    expect(wantedPttButton({ dictation: { ...d, mouseButton: 'x1' } })).toBe('x1')
    expect(wantedPttButton({ dictation: { ...d, mouseButton: 'x1', enabled: false } })).toBe('')
  })
})
