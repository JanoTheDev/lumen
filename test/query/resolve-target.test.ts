import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import type { ElementNode, MonitorInfo, Rect } from '@shared/types'
import type { OcrResult } from '../../src/main/agent/commands'
import { frameGeometryOf, setScreenAdapter } from '../../src/main/actions/coords'
import {
  CONFIDENCE,
  ocrExactMatches,
  resolveFirst,
  resolveTarget,
  type GroundingContext
} from '../../src/main/query/resolve-target'
import { display, screenAdapterFor, type DisplayLayout } from '../helpers/displays'

afterEach(() => setScreenAdapter(null))

const MON_150: MonitorInfo = {
  id: 0,
  rect: { x: 0, y: 0, w: 2880, h: 1800 },
  scale: 1.5,
  primary: true
}
const SINGLE_150: DisplayLayout = {
  name: '2880x1800@150%',
  displays: [display('main', { x: 0, y: 0, width: 2880, height: 1800 }, 1.5, { x: 0, y: 0 }, true)]
}

function el(id: string, name: string, rect: Rect, extra: Partial<ElementNode> = {}): ElementNode {
  return {
    id,
    role: 'button',
    name,
    rect,
    monitorId: 0,
    enabled: true,
    patterns: ['invoke'],
    ...extra
  }
}

function ctxFor(over: Partial<GroundingContext> = {}, monitor = MON_150): GroundingContext {
  return {
    frames: [
      { label: '1', monitor, geometry: frameGeometryOf({ width: 1280, height: 800, monitor }) }
    ],
    ...over
  }
}

function uia(children: ElementNode[]): GroundingContext['uia'] {
  return {
    snapshotId: 's1',
    root: el('e0', 'App', { x: 0, y: 0, w: 2880, h: 1800 }, { role: 'window', children })
  }
}

function word(
  text: string,
  x: number,
  y: number,
  lineIndex: number,
  w = 90
): OcrResult['words'][number] {
  return { text, rect: { x, y, w, h: 30 }, conf: 1, lineIndex }
}

describe('resolveTarget at 150% scaling', () => {
  it('element: UIA rect, logical rect divided by the scale, high confidence', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const ctx = ctxFor({ uia: uia([el('e7', 'Compose', { x: 300, y: 450, w: 240, h: 90 })]) })
    const r = await resolveTarget({ kind: 'element', id: 'e7' }, ctx)
    expect(r).toMatchObject({
      physRect: { x: 300, y: 450, w: 240, h: 90 },
      logicalRect: { x: 200, y: 300, w: 160, h: 60 },
      monitorId: 0,
      elementId: 'e7',
      confidence: CONFIDENCE.element,
      source: 'element'
    })
    expect(await resolveTarget({ kind: 'element', id: 'e99' }, ctx)).toBeNull()
  })

  it('element: disabled drops to 0.3 and says why', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const ctx = ctxFor({
      uia: uia([el('e1', 'Send', { x: 30, y: 30, w: 120, h: 60 }, { enabled: false })])
    })
    const r = await resolveTarget({ kind: 'element', id: 'e1' }, ctx)
    expect(r).toMatchObject({ confidence: 0.3, notes: ['disabled'] })
  })

  it('point: image px → phys → logical, with a pointer-sized box', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    // image 1280 wide shows 2880 phys: 2.25 phys px per image px.
    const r = await resolveTarget({ kind: 'point', x: 640, y: 400, frame: '1' }, ctxFor())
    expect(r?.physRect).toEqual({ x: 1404, y: 864, w: 72, h: 72 })
    expect(r?.logicalRect).toEqual({ x: 936, y: 576, w: 48, h: 48 })
    expect(r).toMatchObject({ confidence: CONFIDENCE.point, source: 'point' })
  })

  it('rect: maps the area; zero-size or off-image targets are never guessed', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const r = await resolveTarget(
      { kind: 'rect', x: 100, y: 100, w: 200, h: 40, frame: '1' },
      ctxFor()
    )
    expect(r?.physRect).toEqual({ x: 225, y: 225, w: 450, h: 90 })
    expect(r?.logicalRect).toEqual({ x: 150, y: 150, w: 300, h: 60 })
    expect(
      await resolveTarget({ kind: 'rect', x: 1, y: 1, w: 0, h: 9, frame: '1' }, ctxFor())
    ).toBeNull()
    expect(await resolveTarget({ kind: 'point', x: 2000, y: 100, frame: '1' }, ctxFor())).toBeNull()
  })
})

describe('mark', () => {
  it('reads the turn marks table with per-source confidence', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const ctx = ctxFor({
      marks: [
        { n: 1, physRect: { x: 10, y: 10, w: 100, h: 40 }, source: 'ocr', label: 'File' },
        {
          n: 2,
          physRect: { x: 300, y: 10, w: 100, h: 40 },
          source: 'uia',
          label: 'button',
          elementId: 'e3'
        }
      ]
    })
    expect(await resolveTarget({ kind: 'mark', n: 1 }, ctx)).toMatchObject({
      physRect: { x: 10, y: 10, w: 100, h: 40 },
      confidence: CONFIDENCE.markOcr,
      source: 'mark'
    })
    expect(await resolveTarget({ kind: 'mark', n: 2 }, ctx)).toMatchObject({
      confidence: CONFIDENCE.markUia,
      elementId: 'e3'
    })
    expect(await resolveTarget({ kind: 'mark', n: 3 }, ctx)).toBeNull()
  })
})

describe('text', () => {
  const ocr: OcrResult = {
    words: [
      word('Stripe', 100, 100, 0),
      word('Invoice', 300, 100, 0),
      word('OxGF', 100, 200, 1),
      word('Weekly', 300, 200, 1),
      word('0xGF', 100, 300, 2),
      word('Digest', 300, 300, 2),
      word('OxGF', 100, 400, 3),
      word('Save', 1000, 1000, 4),
      word('as', 1100, 1000, 4, 40),
      word('PDF', 1150, 1000, 4)
    ],
    lines: []
  }
  const withOcr = (): GroundingContext => ctxFor({ ocr: async () => ocr })

  it('unique exact OCR match (multi-word) → union of the words, 0.85', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const r = await resolveTarget({ kind: 'text', text: 'save as pdf' }, withOcr())
    expect(r).toMatchObject({
      physRect: { x: 1000, y: 1000, w: 240, h: 30 },
      confidence: CONFIDENCE.textUnique,
      source: 'text'
    })
  })

  it('nth in reading order, OCR confusables folded (replaces correctNthElement)', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const third = await resolveTarget({ kind: 'text', text: 'OxGF', nth: 3 }, withOcr())
    expect(third?.physRect.y).toBe(400)
    expect(third?.confidence).toBe(CONFIDENCE.textNth)
    const last = await resolveTarget({ kind: 'text', text: 'OxGF', nth: -1 }, withOcr())
    expect(last?.physRect.y).toBe(400)
    expect(await resolveTarget({ kind: 'text', text: 'OxGF', nth: 4 }, withOcr())).toBeNull()
  })

  it('several matches without nth → the first, flagged ambiguous', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const r = await resolveTarget({ kind: 'text', text: 'oxgf' }, withOcr())
    expect(r).toMatchObject({ confidence: CONFIDENCE.textFuzzy, notes: ['3 matches'] })
    expect(r?.physRect.y).toBe(200)
  })

  it('falls back to a fuzzy line match', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const ctx = ctxFor({
      ocr: async () => ({
        words: [],
        lines: [
          { text: 'Your weekly digest is ready', rect: { x: 50, y: 60, w: 600, h: 30 }, conf: 1 }
        ]
      })
    })
    const r = await resolveTarget({ kind: 'text', text: 'weekly digest' }, ctx)
    expect(r).toMatchObject({ confidence: CONFIDENCE.textFuzzy, notes: ['fuzzy'] })
    expect(await resolveTarget({ kind: 'text', text: 'nowhere' }, ctx)).toBeNull()
  })

  it('prefers a UIA name match (no OCR call) and returns its element id', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const ocrFn = vi.fn(async () => ocr)
    const ctx = ctxFor({
      uia: uia([el('e5', 'Compose', { x: 30, y: 300, w: 200, h: 60 })]),
      ocr: ocrFn
    })
    const r = await resolveTarget({ kind: 'text', text: 'compose' }, ctx)
    expect(r).toMatchObject({ elementId: 'e5', confidence: CONFIDENCE.textUnique })
    expect(ocrFn).not.toHaveBeenCalled()
  })

  it('returns null when there is no OCR and no UIA', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    expect(await resolveTarget({ kind: 'text', text: 'File' }, ctxFor())).toBeNull()
  })

  it('matches lines when the OCR has no word grouping', () => {
    const rects = ocrExactMatches(
      { words: [], lines: [{ text: 'File', rect: { x: 1, y: 2, w: 3, h: 4 }, conf: 1 }] },
      'file'
    )
    expect(rects).toEqual([{ x: 1, y: 2, w: 3, h: 4 }])
  })
})

describe('penalties', () => {
  it('tiny targets and targets off the foreground window lose confidence', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const ctx = ctxFor({
      foreground: { rect: { x: 0, y: 0, w: 1000, h: 1000 } },
      uia: uia([
        el('e1', 'dot', { x: 10, y: 10, w: 9, h: 9 }),
        el('e2', 'Outside', { x: 2000, y: 1500, w: 200, h: 60 })
      ])
    })
    expect(await resolveTarget({ kind: 'element', id: 'e1' }, ctx)).toMatchObject({
      confidence: 0.75,
      notes: ['tiny']
    })
    expect(await resolveTarget({ kind: 'element', id: 'e2' }, ctx)).toMatchObject({
      confidence: 0.65,
      notes: ['off-window']
    })
  })
})

describe('synthetic two-monitor layout', () => {
  // Primary 1920x1080 @100% at 0,0; second monitor 2880x1800 @150% to the left (negative x).
  const LAYOUT: DisplayLayout = {
    name: 'primary + 150% left',
    displays: [
      display('primary', { x: 0, y: 0, width: 1920, height: 1080 }, 1, { x: 0, y: 0 }, true),
      display('left', { x: -2880, y: 0, width: 2880, height: 1800 }, 1.5, { x: -1920, y: 0 })
    ]
  }
  const LEFT: MonitorInfo = {
    id: 0,
    rect: { x: -2880, y: 0, w: 2880, h: 1800 },
    scale: 1.5,
    primary: false
  }

  it('maps a point on the 150% monitor through that frame offset and scale', async () => {
    setScreenAdapter(screenAdapterFor(LAYOUT))
    const r = await resolveTarget({ kind: 'point', x: 640, y: 400, frame: '1' }, ctxFor({}, LEFT))
    // 640 image px * 2.25 = 1440 phys from the monitor's left edge at -2880.
    expect(r?.physRect).toEqual({ x: -1476, y: 864, w: 72, h: 72 })
    expect(r?.logicalRect.x).toBeCloseTo(-1920 + 1404 / 1.5)
    expect(r?.logicalRect.w).toBeCloseTo(48)
    expect(r?.monitorId).toBe(0)
  })

  it('picks the frame named by the target', async () => {
    setScreenAdapter(screenAdapterFor(LAYOUT))
    const PRIMARY: MonitorInfo = {
      id: 1,
      rect: { x: 0, y: 0, w: 1920, h: 1080 },
      scale: 1,
      primary: true
    }
    const ctx: GroundingContext = {
      frames: [
        {
          label: '1',
          monitor: LEFT,
          geometry: frameGeometryOf({ width: 1280, height: 800, monitor: LEFT })
        },
        {
          label: '2',
          monitor: PRIMARY,
          geometry: frameGeometryOf({ width: 1280, height: 720, monitor: PRIMARY })
        }
      ]
    }
    const r = await resolveTarget({ kind: 'rect', x: 640, y: 360, w: 64, h: 36, frame: '2' }, ctx)
    expect(r?.physRect).toEqual({ x: 960, y: 540, w: 96, h: 54 })
    expect(r?.logicalRect).toEqual({ x: 960, y: 540, w: 96, h: 54 })
    expect(r?.monitorId).toBe(1)
  })

  it('UIA rects on the left monitor convert with its 150% scale', async () => {
    setScreenAdapter(screenAdapterFor(LAYOUT))
    const ctx = ctxFor(
      { uia: uia([el('e1', 'OK', { x: -2880 + 300, y: 300, w: 150, h: 60 })]) },
      LEFT
    )
    const r = await resolveTarget({ kind: 'element', id: 'e1' }, ctx)
    expect(r?.logicalRect.x).toBeCloseTo(-1920 + 200)
    expect(r?.logicalRect).toMatchObject({ y: 200, w: 100, h: 40 })
  })
})

describe('resolveFirst', () => {
  it('takes the first target that resolves', async () => {
    setScreenAdapter(screenAdapterFor(SINGLE_150))
    const r = await resolveFirst(
      [
        { kind: 'element', id: 'missing' },
        { kind: 'rect', x: 0, y: 0, w: 100, h: 100, frame: '1' }
      ],
      ctxFor()
    )
    expect(r?.source).toBe('rect')
  })
})
