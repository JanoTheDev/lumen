import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Rect } from '../../src/shared/types'
import {
  DEBOUNCE_MS,
  FIRST_ITEM_FACTOR,
  Scanner,
  scanRows,
  toScanScene,
  type ScanLevel,
  type ScanSettings,
  type ScanView
} from '../../src/main/a11y/switch'

const AUTO: ScanSettings = { mode: 'auto', intervalMs: 1000, loops: 2 }
const FIRST = AUTO.intervalMs * FIRST_ITEM_FACTOR

function level(title: string, labels: string[], picked: string[] = []): ScanLevel {
  return {
    title,
    items: labels.map((label) => ({
      label,
      select: () => {
        picked.push(label)
        return 'root' as const
      }
    }))
  }
}

interface Setup {
  scanner: Scanner
  views: (ScanView | null)[]
  said: string[]
  highlighted: () => string | undefined
  settings: ScanSettings
}

function setup(root: () => ScanLevel, settings: Partial<ScanSettings> = {}): Setup {
  const views: (ScanView | null)[] = []
  const said: string[] = []
  const s = { ...AUTO, ...settings }
  const scanner = new Scanner({
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    settings: () => s,
    root,
    render: (v) => views.push(v),
    announce: (t) => said.push(t),
    log: () => {}
  })
  const highlighted = (): string | undefined => {
    const v = views[views.length - 1]
    return v ? v.items[v.index]?.label : undefined
  }
  return { scanner, views, said, highlighted, settings: s }
}

/** Presses and lets the async select settle. */
async function press(scanner: Scanner, role: 'select' | 'next' = 'select'): Promise<boolean> {
  const ok = scanner.press(role)
  await vi.advanceTimersByTimeAsync(0)
  return ok
}

describe('Scanner (1-switch auto-scan)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('highlights the first item, then moves every interval (first item held longer)', () => {
    const t = setup(() => level('Top', ['A', 'B', 'C']))
    t.scanner.start()
    expect(t.highlighted()).toBe('A')
    vi.advanceTimersByTime(AUTO.intervalMs)
    expect(t.highlighted()).toBe('A')
    vi.advanceTimersByTime(FIRST - AUTO.intervalMs)
    expect(t.highlighted()).toBe('B')
    vi.advanceTimersByTime(AUTO.intervalMs)
    expect(t.highlighted()).toBe('C')
    expect(t.said).toEqual(['A', 'B', 'C'])
  })

  it('adds "Pause scanning" at the top and "Back" in sub-levels', () => {
    const sub = level('Sub', ['x'])
    const t = setup(() => ({
      title: 'Top',
      items: [{ label: 'Open', select: () => ({ push: sub }) }]
    }))
    t.scanner.start()
    expect(t.views.at(-1)!.items.map((i) => i.label)).toEqual(['Open', 'Pause scanning'])
    t.scanner.press('select')
    return vi.advanceTimersByTimeAsync(0).then(() => {
      expect(t.views.at(-1)!.items.map((i) => i.label)).toEqual(['x', 'Back'])
      expect(t.scanner.path()).toEqual(['Top', 'Sub'])
    })
  })

  it('selects the highlighted item and starts over at the top', async () => {
    const picked: string[] = []
    const t = setup(() => level('Top', ['A', 'B'], picked))
    t.scanner.start()
    vi.advanceTimersByTime(FIRST)
    expect(await press(t.scanner)).toBe(true)
    expect(picked).toEqual(['B'])
    expect(t.highlighted()).toBe('A')
  })

  it('backs out of a sub-level after `loops` passes and goes idle at the top', async () => {
    const t = setup(() => ({
      title: 'Top',
      items: [{ label: 'Open', select: () => ({ push: level('Sub', ['x']) }) }]
    }))
    t.scanner.start()
    await press(t.scanner)
    expect(t.scanner.path()).toEqual(['Top', 'Sub'])
    // Sub has x + Back: two passes = 4 steps (first held longer).
    vi.advanceTimersByTime(FIRST + AUTO.intervalMs * 3)
    expect(t.scanner.path()).toEqual(['Top'])
    vi.advanceTimersByTime(FIRST + AUTO.intervalMs * 3)
    expect(t.scanner.state).toBe('idle')
    expect(t.views.at(-1)).toBeNull()
    expect(t.said.at(-1)).toMatch(/paused/i)
  })

  it('a press while idle starts again at the top; presses while off are ignored', async () => {
    const t = setup(() => level('Top', ['A']))
    expect(await press(t.scanner)).toBe(false)
    t.scanner.start()
    vi.advanceTimersByTime(FIRST) // Pause scanning
    await press(t.scanner)
    expect(t.scanner.state).toBe('idle')
    vi.advanceTimersByTime(DEBOUNCE_MS)
    await press(t.scanner)
    expect(t.scanner.state).toBe('scanning')
    expect(t.highlighted()).toBe('A')
  })

  it('debounces presses closer than DEBOUNCE_MS', async () => {
    const picked: string[] = []
    const t = setup(() => level('Top', ['A', 'B'], picked))
    t.scanner.start()
    await press(t.scanner)
    vi.advanceTimersByTime(DEBOUNCE_MS - 10)
    expect(await press(t.scanner)).toBe(false)
    expect(picked).toEqual(['A'])
  })

  it('ignores presses while an action runs and stays put on "stay"', async () => {
    let finish: () => void = () => {}
    const t = setup(() => ({
      title: 'Top',
      items: [
        {
          label: 'Slow',
          select: () =>
            new Promise<'stay'>((r) => {
              finish = () => r('stay')
            })
        },
        { label: 'B', select: () => 'root' as const }
      ]
    }))
    t.scanner.start()
    t.scanner.press('select')
    expect(t.scanner.state).toBe('busy')
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(t.scanner.press('select')).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(t.highlighted()).toBe('Slow')
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.scanner.state).toBe('scanning')
    expect(t.highlighted()).toBe('Slow')
  })

  it('a failing action keeps scanning', async () => {
    const t = setup(() => ({
      title: 'Top',
      items: [
        {
          label: 'Bad',
          select: () => {
            throw new Error('nope')
          }
        }
      ]
    }))
    t.scanner.start()
    await press(t.scanner)
    expect(t.scanner.state).toBe('scanning')
  })

  it('replace swaps the level without running its onExit; back runs it', async () => {
    const exits: string[] = []
    const grid = (n: number): ScanLevel => ({
      title: `Grid ${n}`,
      onExit: () => exits.push(`Grid ${n}`),
      items: [{ label: 'zoom', select: () => ({ replace: grid(n + 1) }) }]
    })
    const t = setup(() => ({
      title: 'Top',
      items: [{ label: 'Grid', select: () => ({ push: grid(0) }) }]
    }))
    t.scanner.start()
    await press(t.scanner)
    vi.advanceTimersByTime(DEBOUNCE_MS)
    await press(t.scanner)
    expect(t.scanner.path()).toEqual(['Top', 'Grid 1'])
    expect(exits).toEqual([])
    vi.advanceTimersByTime(FIRST) // Back
    await press(t.scanner)
    expect(exits).toEqual(['Grid 1'])
    expect(t.scanner.path()).toEqual(['Top'])
  })

  it('stop clears the drawing, runs every onExit and ignores later presses', async () => {
    const exits: string[] = []
    const t = setup(() => ({
      title: 'Top',
      onExit: () => exits.push('Top'),
      items: [
        {
          label: 'Open',
          select: () => ({ push: { ...level('Sub', ['x']), onExit: () => exits.push('Sub') } })
        }
      ]
    }))
    t.scanner.start()
    await press(t.scanner)
    t.scanner.stop()
    expect(exits).toEqual(['Sub', 'Top'])
    expect(t.views.at(-1)).toBeNull()
    vi.advanceTimersByTime(10_000)
    expect(t.views.at(-1)).toBeNull()
    expect(await press(t.scanner)).toBe(false)
  })

  it('tells the level which item is highlighted', () => {
    const marks: (number | null)[] = []
    const t = setup(() => ({ ...level('Top', ['A', 'B']), onHighlight: (i) => marks.push(i) }))
    t.scanner.start()
    vi.advanceTimersByTime(FIRST)
    t.scanner.stop()
    expect(marks).toEqual([0, 1, null])
  })
})

describe('Scanner (2-switch step-scan)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not move by itself; switch A moves, switch B selects, wrapping forever', async () => {
    const picked: string[] = []
    const t = setup(() => level('Top', ['A', 'B'], picked), { mode: 'step' })
    t.scanner.start()
    vi.advanceTimersByTime(60_000)
    expect(t.highlighted()).toBe('A')
    for (let i = 0; i < 4; i++) {
      await press(t.scanner, 'next')
      vi.advanceTimersByTime(DEBOUNCE_MS)
    }
    // A → B → Pause → A → B
    expect(t.highlighted()).toBe('B')
    await press(t.scanner, 'select')
    expect(picked).toEqual(['B'])
  })
})

describe('scanRows', () => {
  const r = (x: number, y: number, h = 20): { rect: Rect } => ({ rect: { x, y, w: 30, h } })

  it('groups by line in reading order and splits long rows into chunks of 8', () => {
    const items = [
      r(100, 5),
      r(0, 0),
      r(50, 52),
      ...Array.from({ length: 10 }, (_, i) => r(i * 40, 100))
    ]
    const rows = scanRows(items)
    expect(rows.map((row) => row.length)).toEqual([2, 1, 8, 2])
    expect(rows[0].map((i) => i.rect.x)).toEqual([0, 100])
  })
})

describe('toScanScene', () => {
  const rect = { x: 1, y: 2, w: 3, h: 4 }
  const view = (index: number, external = false): ScanView => ({
    title: 'Grid',
    items: [{ label: '5', rect, n: 5 }, { label: 'Act here' }, { label: 'Back' }],
    index,
    external
  })

  it('rings items with a rect and lists the menu for the rest', () => {
    expect(toScanScene(view(0), { x: 9, y: 9 })).toEqual({ ring: { rect, label: '5', n: 5 } })
    expect(toScanScene(view(1), { x: 9, y: 9 })).toEqual({
      menu: { title: 'Grid', items: ['5', 'Act here', 'Back'], index: 1, at: { x: 9, y: 9 } }
    })
    expect(toScanScene({ ...view(2), anchor: { x: 5, y: 6 } }, { x: 9, y: 9 })?.menu?.at).toEqual({
      x: 5,
      y: 6
    })
  })

  it('draws nothing when stopped or for a level that draws itself', () => {
    expect(toScanScene(null, { x: 0, y: 0 })).toBeUndefined()
    expect(toScanScene(view(1, true), { x: 0, y: 0 })).toBeUndefined()
  })
})
