import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import type { ElementNode } from '@shared/types'
import { frameGeometryOf } from '../../src/main/actions/coords'
import {
  coverage,
  elementIndex,
  serializeElements,
  uiaQuality
} from '../../src/main/query/uia-list'
import { userTurn } from '../../src/main/ai/prompts/assemble'

let seq = 0
function el(
  role: string,
  name: string,
  x: number,
  y: number,
  extra: Partial<ElementNode> = {}
): ElementNode {
  return {
    id: `e${++seq}`,
    role,
    name,
    rect: { x, y, w: 100, h: 30 },
    monitorId: 0,
    enabled: true,
    patterns: ['invoke'],
    ...extra
  }
}

const MON = { id: 0, rect: { x: 0, y: 0, w: 2560, h: 1440 }, scale: 1.5, primary: true }
// 2560x1440 physical shown as a 1280x720 image.
const FRAME = frameGeometryOf({ width: 1280, height: 720, monitor: MON })
const FRAME_RECT = { x: 0, y: 0, w: 2560, h: 1440 }

function snapshot(children: ElementNode[]): { snapshotId: string; root: ElementNode } {
  return {
    snapshotId: 's1',
    root: { ...el('window', 'App', 0, 0), rect: FRAME_RECT, children }
  }
}

describe('uiaQuality', () => {
  it('is good with >= 5 named nodes covering >= 30% of the window', () => {
    const big = [0, 1, 2, 3, 4].map((i) =>
      el('button', `B${i}`, 0, i * 288, { rect: { x: 0, y: i * 288, w: 1280, h: 280 } })
    )
    expect(uiaQuality(snapshot(big), FRAME_RECT)).toBe('good')
  })

  it('is partial when a large unnamed pane dominates (Blender viewport)', () => {
    const chrome = [0, 1, 2, 3, 4, 5].map((i) => el('menuitem', `M${i}`, i * 110, 0))
    const viewport = el('button', '', 0, 40, { rect: { x: 0, y: 40, w: 2560, h: 1400 } })
    expect(uiaQuality(snapshot([...chrome, viewport]), FRAME_RECT)).toBe('partial')
  })

  it('is none without interactive nodes on the frame', () => {
    const offFrame = [el('button', 'Other screen', -1000, 10)]
    expect(uiaQuality(snapshot(offFrame), FRAME_RECT)).toBe('none')
    expect(uiaQuality(undefined, FRAME_RECT)).toBe('none')
  })

  it('follows the skill pack', () => {
    expect(uiaQuality(undefined, FRAME_RECT, undefined, 'good')).toBe('good')
    const many = [0, 1, 2, 3, 4, 5].map((i) =>
      el('button', `B${i}`, 0, 0, { rect: { x: 0, y: i * 240, w: 2560, h: 240 } })
    )
    expect(uiaQuality(snapshot(many), FRAME_RECT, undefined, 'partial')).toBe('partial')
  })

  it('measures union coverage without double counting overlaps', () => {
    const r = { x: 0, y: 0, w: 50, h: 100 }
    expect(coverage([r, r], { x: 0, y: 0, w: 100, h: 100 })).toBeCloseTo(0.5, 1)
  })
})

describe('serializeElements', () => {
  it('writes C3 lines in frame px, indented by depth, interactive only', () => {
    const item = el('listitem', 'Inbox "primary"', 200, 300)
    const list = el('list', 'Folders', 0, 0, { children: [item] })
    const compose = el('button', 'Compose', 24, 360, { focused: true })
    const text = el('text', 'Label', 10, 10)
    const out = serializeElements(snapshot([compose, list, text]), FRAME)!
    expect(out.text.split('\n')).toEqual([
      `${compose.id} button "Compose" @(12,180,50,15) focused`,
      `${item.id} listitem "Inbox 'primary'" @(100,150,50,15)`
    ])
    expect(out.count).toBe(2)
    expect(out.tokens).toBe(Math.ceil(out.text.length / 3.5))
  })

  it('nests children of kept nodes', () => {
    const child = el('menuitem', 'Open', 0, 40)
    const parent = el('menuitem', 'File', 0, 0, { children: [child] })
    const lines = serializeElements(snapshot([parent]), FRAME)!.text.split('\n')
    expect(lines[1].startsWith(`  ${child.id} menuitem "Open"`)).toBe(true)
  })

  it('redacts password values and caps names at 60 chars', () => {
    const pw = el('edit', 'Password', 0, 0, { patterns: ['value'], value: 'hunter2' })
    const masked = el('edit', 'Field', 0, 40, { patterns: ['value'], value: '••••' })
    const pin = el('edit', 'Enter PIN', 0, 80, { patterns: ['value'], value: '1234' })
    const search = el('edit', 'x'.repeat(80), 0, 120, { patterns: ['value'], value: 'cats' })
    const disabled = el('button', 'Send', 0, 160, { enabled: false })
    const text = serializeElements(snapshot([pw, masked, pin, search, disabled]), FRAME)!.text
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('1234')
    expect(text.match(/<redacted>/g)).toHaveLength(3)
    expect(text).toContain(`"${'x'.repeat(59)}…"`)
    expect(text).toContain('value="cats"')
    expect(text).toContain(`${disabled.id} button "Send" @(0,80,50,15) disabled`)
  })

  it('drops nodes on other monitors and caps nodes and tokens', () => {
    const other = el('button', 'Elsewhere', -500, 0)
    const many = Array.from({ length: 50 }, (_, i) => el('button', `Button ${i}`, 0, i * 20))
    const capped = serializeElements(snapshot([other, ...many]), FRAME, 10)!
    expect(capped.count).toBe(10)
    expect(capped.truncated).toBe(true)
    expect(capped.text).not.toContain('Elsewhere')
    const budget = serializeElements(snapshot(many), FRAME, 400, 100)!
    expect(budget.tokens).toBeLessThanOrEqual(100)
    expect(budget.truncated).toBe(true)
  })

  it('keeps an Explorer-sized window (150 nodes) well under 2.5k tokens', () => {
    const files = Array.from({ length: 150 }, (_, i) =>
      el('listitem', `Quarterly report ${i}.xlsx`, 400, 100 + i * 8)
    )
    const out = serializeElements(snapshot(files), FRAME)!
    expect(out.count).toBe(150)
    expect(out.tokens).toBeLessThan(2500)
  })

  it('indexes every node by id', () => {
    const child = el('menuitem', 'Open', 0, 40)
    const idx = elementIndex(snapshot([el('menuitem', 'File', 0, 0, { children: [child] })]))
    expect(idx.get(child.id)?.name).toBe('Open')
  })
})

describe('user turn', () => {
  it('places the elements list inside <context>', () => {
    const turn = userTurn({
      prompt: 'click compose',
      activeWindow: 'Gmail',
      frame: { w: 1280, h: 720 },
      elements: 'e1 button "Compose" @(12,180,50,15)',
      now: new Date(0)
    })
    expect(turn).toMatch(
      /elements \(id role "name" @\(x,y,w,h\) in frame "1" px\):\ne1 button "Compose" @\(12,180,50,15\)\n<\/context>/
    )
  })
})
