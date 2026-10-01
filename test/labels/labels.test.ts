import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ElementNode } from '@shared/types'
import type { GrayImage } from '../../src/main/ai/frames'
import { isGenericName, isUnnamed, unnamedNodes } from '../../src/main/labels/detect'
import { hashDistance, iconHash } from '../../src/main/labels/hash'
import { parseLabelCommand } from '../../src/main/labels/grammar'
import { readReply } from '../../src/main/labels/prompt'
import { LabelStore, labelKey, parseLabelsFile } from '../../src/main/labels/store'
import { createLabeler, nodeAt, spokenLabel, toImageRect } from '../../src/main/labels/core'
import { tempDir } from '../helpers/fixtures'

const node = (over: Partial<ElementNode>): ElementNode => ({
  id: over.id ?? 'e1',
  role: 'button',
  name: '',
  rect: { x: 10, y: 10, w: 24, h: 24 },
  monitorId: 0,
  enabled: true,
  patterns: ['invoke'],
  ...over
})

const root = (children: ElementNode[]): ElementNode =>
  node({ id: 'root', role: 'window', name: 'App', rect: { x: 0, y: 0, w: 800, h: 600 }, children })

function img(fn: (x: number, y: number) => number, w = 36, h = 36): GrayImage {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y)
  return { w, h, data }
}

describe('detect', () => {
  it('generic and machine names', () => {
    for (const n of ['', 'x', 'button', 'Icon', 'btn_3', 'ImageButton12', 'QToolButton', '123'])
      expect(isGenericName(n, 'button')).toBe(true)
    for (const n of ['Render', 'Add object', 'OK']) expect(isGenericName(n, 'button')).toBe(false)
  })

  it('finds unnamed interactive controls, top-left first', () => {
    const r = root([
      node({ id: 'b', rect: { x: 100, y: 50, w: 20, h: 20 } }),
      node({ id: 'a', rect: { x: 10, y: 50, w: 20, h: 20 } }),
      node({ id: 'named', name: 'Save' }),
      node({ id: 'edit', role: 'edit' }),
      node({ id: 'huge', rect: { x: 0, y: 0, w: 900, h: 900 } })
    ])
    expect(unnamedNodes(r).map((n) => n.id)).toEqual(['a', 'b'])
    expect(isUnnamed(node({ name: 'Save' }))).toBe(false)
  })
})

describe('iconHash', () => {
  it('is stable under small changes and differs for other icons', () => {
    const a = iconHash(img((x) => (x < 18 ? 20 : 220)))!
    const a2 = iconHash(img((x, y) => (x < 18 ? 24 : 215) + (y % 3)))!
    const b = iconHash(img((x) => (x < 18 ? 220 : 20)))
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(hashDistance(a, a2)).toBeLessThanOrEqual(6)
    expect(b === null || hashDistance(a, b) > 6).toBe(true)
    expect(iconHash(img(() => 128))).toBeNull()
  })
})

describe('grammar', () => {
  it.each([
    ['label the buttons', 'label-window'],
    ['Name all the unnamed buttons in this window', 'label-window'],
    ['label everything', 'label-window']
  ])('%s', (u, kind) => expect(parseLabelCommand(u)?.kind).toBe(kind))

  it('name this … keeps the words', () => {
    expect(parseLabelCommand('name this Render')).toEqual({ kind: 'name-this', label: 'Render' })
    expect(parseLabelCommand('call this button add keyframe.')).toEqual({
      kind: 'name-this',
      label: 'Add keyframe'
    })
    expect(parseLabelCommand('name this window')).toEqual({ kind: 'label-window' })
    expect(parseLabelCommand('click the render button')).toBeNull()
  })
})

describe('readReply', () => {
  it('drops empty, unsure and out-of-range labels', () => {
    const m = readReply(
      {
        labels: [
          { n: 1, label: ' Render. ', description: 'Renders', confidence: 0.9 },
          { n: 2, label: '', description: '', confidence: 0 },
          { n: 3, label: 'Zoom', description: '', confidence: 0 },
          { n: 9, label: 'X', description: '', confidence: 1 }
        ]
      },
      3
    )
    expect([...m.keys()]).toEqual([1])
    expect(m.get(1)?.label).toBe('Render')
  })
})

describe('LabelStore', () => {
  let cleanup = (): void => {}
  afterEach(() => cleanup())

  function store(pack: ReturnType<typeof parseLabelsFile> = null): LabelStore {
    const t = tempDir()
    cleanup = t.cleanup
    return new LabelStore(
      t.dir,
      () => pack?.labels ?? [],
      () => '2026-10-01'
    )
  }

  it('finds by automation id, then by icon hash', () => {
    const s = store()
    s.put('blender', 'Blender', [
      { role: 'button', automationId: 'render', label: 'Render', source: 'ai', confidence: 0.8 },
      {
        role: 'button',
        iconHash: 'ff00ff00ff00ff00',
        label: 'Zoom in',
        source: 'ai',
        confidence: 0.6
      }
    ])
    expect(s.find('blender', { role: 'button', automationId: 'render' })?.label).toBe('Render')
    expect(s.find('blender', { role: 'button', iconHash: 'ff00ff00ff00ff01' })?.label).toBe(
      'Zoom in'
    )
    expect(s.find('blender', { role: 'tabitem', automationId: 'render' })).toBeNull()
    expect(s.apps()).toEqual([{ app: 'blender', appName: 'Blender', count: 2, human: 0 }])
  })

  it('never replaces a human label with an AI or shared one', () => {
    const s = store()
    const base = { role: 'button', automationId: 'r' }
    s.put('app', 'App', [{ ...base, label: 'Mine', source: 'human', confidence: 1 }])
    expect(s.put('app', 'App', [{ ...base, label: 'Guess', source: 'ai', confidence: 0.9 }])).toBe(
      0
    )
    s.put('app', 'App', [{ ...base, label: 'Theirs', source: 'human', confidence: 1 }], 'shared')
    expect(s.find('app', base)?.label).toBe('Mine')
  })

  it('edit makes a label human; null deletes it; export drops origin', () => {
    const s = store()
    const l = {
      role: 'button',
      automationId: 'r',
      label: 'Guess',
      source: 'ai' as const,
      confidence: 0.4
    }
    s.put('app', 'App', [l])
    expect(s.edit('app', labelKey(l), 'Run')).toBe(true)
    expect(s.find('app', l)).toMatchObject({ label: 'Run', source: 'human', confidence: 1 })
    const out = s.exportFile('app')!
    expect(parseLabelsFile(out)).not.toBeNull()
    expect(out.labels[0]).not.toHaveProperty('origin')
    expect(s.edit('app', labelKey(l), null)).toBe(true)
    expect(s.entries('app')).toEqual([])
  })

  it('falls back to the app pack labels', () => {
    const s = store({
      format: 1,
      app: 'gimp',
      labels: [
        { role: 'button', automationId: 'x', label: 'Paint', source: 'human', confidence: 1 }
      ]
    })
    expect(s.find('gimp', { role: 'button', automationId: 'x' })?.label).toBe('Paint')
  })

  it('rejects bad app ids and invalid files', () => {
    const s = store()
    expect(() =>
      s.put('../evil', 'x', [
        { role: 'button', automationId: 'a', label: 'A', source: 'ai', confidence: 1 }
      ])
    ).toThrow()
    const noKey = { role: 'button', label: 'x', source: 'ai', confidence: 1 }
    expect(parseLabelsFile({ format: 1, app: 'a', labels: [noKey] })).toBeNull()
  })
})

interface Setup {
  l: ReturnType<typeof createLabeler>
  s: LabelStore
  complete: ReturnType<typeof vi.fn>
}

describe('createLabeler', () => {
  let cleanup = (): void => {}
  afterEach(() => cleanup())

  function setup(reply: unknown): Setup {
    const t = tempDir()
    cleanup = t.cleanup
    const s = new LabelStore(t.dir)
    const r = root([
      node({ id: 'a', automationId: 'render', rect: { x: 110, y: 60, w: 24, h: 24 } }),
      node({ id: 'b', rect: { x: 150, y: 60, w: 24, h: 24 } }),
      node({ id: 'n', name: 'Open', rect: { x: 200, y: 60, w: 60, h: 24 } })
    ])
    const complete = vi.fn(async () => reply as never)
    const l = createLabeler({
      window: async () => ({ title: 'Blender', rect: { x: 100, y: 50, w: 400, h: 300 } }),
      appOf: () => ({ id: 'blender', name: 'Blender' }),
      snapshot: async () => r,
      capture: async (region) => ({ data: 'IMG', width: region.w, region }),
      crop: (_b, rect) => `crop:${Math.round(rect.x)}`,
      gray: (b64) => img((x) => (x < (b64.length % 30) + 3 ? 10 : 240)),
      hasModel: () => true,
      complete,
      store: s,
      log: () => {}
    })
    return { l, s, complete }
  }

  it('names the unnamed controls in one call and remembers them', async () => {
    const { l, s, complete } = setup({
      labels: [
        { n: 1, label: 'Render', description: 'Renders the frame.', confidence: 0.9 },
        { n: 2, label: 'Zoom in', description: '', confidence: 0.4 }
      ]
    })
    const r = await l.labelWindow()
    expect(r).toMatchObject({ ok: true, named: 2, asked: 2 })
    expect(complete).toHaveBeenCalledTimes(1)
    expect((complete.mock.calls[0] as unknown[])[2]).toHaveLength(2)
    expect(s.find('blender', { role: 'button', automationId: 'render' })?.label).toBe('Render')
    // Asked again: everything is known, no second call.
    expect(await l.labelWindow()).toMatchObject({ ok: false, reason: 'all-known' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(await l.labelAt({ x: 115, y: 65 })).toBe(
      'Render, button. Renders the frame. Label made by AI.'
    )
    expect(await l.labelAt({ x: 210, y: 65 })).toBeNull()
  })

  it('a person names one by pointing', async () => {
    const { l, s } = setup({ labels: [] })
    expect(await l.nameAt({ x: 115, y: 65 }, 'Render')).toMatchObject({ ok: true })
    expect(s.find('blender', { role: 'button', automationId: 'render' })).toMatchObject({
      source: 'human'
    })
  })

  it('helpers', () => {
    const f = { data: '', width: 200, region: { x: 100, y: 0, w: 400, h: 300 } }
    expect(toImageRect(f, { x: 300, y: 100, w: 40, h: 20 })).toEqual({
      x: 100,
      y: 50,
      w: 20,
      h: 10
    })
    expect(nodeAt(root([node({ id: 'a' })]), { x: 12, y: 12 })?.id).toBe('a')
    const tab = { role: 'tabitem', label: 'Tools', source: 'human' as const, confidence: 1 }
    expect(spokenLabel({ ...tab, automationId: 'x' })).toBe('Tools, tab.')
  })
})
