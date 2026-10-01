import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import {
  MarksState,
  PAGE_SIZE,
  REUSE_MS,
  buildScreenMarks,
  findByName,
  isMarkRole,
  reusable,
  type MarksTable
} from '../../src/main/a11y/marks'
import { node } from '../helpers/fake-a11y-io'

const AREA = { x: 0, y: 0, w: 1920, h: 1080 }

function grid(n: number, cols = 10): ReturnType<typeof node>[] {
  return Array.from({ length: n }, (_, i) =>
    node(`b${i}`, { x: 20 + (i % cols) * 150, y: 20 + Math.floor(i / cols) * 40, w: 100, h: 24 })
  )
}

describe('buildScreenMarks', () => {
  it('numbers interactive, enabled nodes in reading order from 1', () => {
    const nodes = [
      node('Second', { x: 400, y: 10, w: 80, h: 30 }),
      node('Third', { x: 10, y: 200, w: 80, h: 30 }),
      node('First', { x: 10, y: 12, w: 80, h: 30 }),
      { ...node('Off', { x: 600, y: 10, w: 80, h: 30 }), enabled: false },
      node('Pane', { x: 10, y: 300, w: 80, h: 30 }, 'pane', []),
      node('Fourth', { x: 300, y: 200, w: 80, h: 30 }),
      node('Fifth', { x: 600, y: 200, w: 80, h: 30 })
    ]
    const table = buildScreenMarks({ nodes, area: AREA })
    expect(table.map((m) => [m.n, m.label])).toEqual([
      [1, 'First'],
      [2, 'Second'],
      [3, 'Third'],
      [4, 'Fourth'],
      [5, 'Fifth']
    ])
    expect(table.every((m) => m.source === 'uia' && m.elementId)).toBe(true)
  })

  it('drops controls outside the window area', () => {
    const nodes = [...grid(5), node('Elsewhere', { x: 3000, y: 10, w: 80, h: 30 })]
    const table = buildScreenMarks({ nodes, area: AREA })
    expect(table).toHaveLength(5)
    expect(table.some((m) => m.label === 'Elsewhere')).toBe(false)
  })

  it('fills in with OCR lines when UIA finds fewer than 5 controls', () => {
    const ocr = [
      { text: 'Inbox', rect: { x: 10, y: 400, w: 60, h: 20 }, conf: 1 },
      { text: 'Sent', rect: { x: 10, y: 440, w: 60, h: 20 }, conf: 1 }
    ]
    const table = buildScreenMarks({ nodes: grid(2), area: AREA, ocrLines: ocr })
    expect(table).toHaveLength(4)
    expect(table.filter((m) => m.source === 'ocr').map((m) => m.label)).toEqual(['Inbox', 'Sent'])
  })

  it('ignores OCR when UIA is rich enough', () => {
    const ocr = [{ text: 'Inbox', rect: { x: 10, y: 900, w: 60, h: 20 }, conf: 1 }]
    const table = buildScreenMarks({ nodes: grid(6), area: AREA, ocrLines: ocr })
    expect(table.every((m) => m.source === 'uia')).toBe(true)
  })

  it('filters by role for "numbers for links"', () => {
    const nodes = [
      node('Home', { x: 10, y: 10, w: 80, h: 20 }, 'hyperlink'),
      node('Save', { x: 100, y: 10, w: 80, h: 20 }, 'button'),
      node('Name', { x: 200, y: 10, w: 80, h: 20 }, 'edit', ['value']),
      node('About', { x: 300, y: 10, w: 80, h: 20 }, 'hyperlink')
    ]
    const links = buildScreenMarks({ nodes, area: AREA, role: 'links' })
    expect(links.map((m) => m.label)).toEqual(['Home', 'About'])
    const fields = buildScreenMarks({ nodes, area: AREA, role: 'fields' })
    expect(fields.map((m) => m.label)).toEqual(['Name'])
  })

  it('knows its roles', () => {
    expect(isMarkRole('links')).toBe(true)
    expect(isMarkRole('windows')).toBe(false)
    expect(isMarkRole(undefined)).toBe(false)
  })
})

describe('reusable', () => {
  const table = buildScreenMarks({ nodes: grid(6), area: AREA })
  it('reuses a fresh table with enough marks', () => {
    expect(reusable(table, 1000, 1000 + REUSE_MS)).toBe(true)
  })
  it('rejects a stale, thin or missing table', () => {
    expect(reusable(table, 1000, 1001 + REUSE_MS)).toBe(false)
    expect(reusable(table.slice(0, 3), 1000, 1000)).toBe(false)
    expect(reusable(undefined, 1000, 1000)).toBe(false)
  })
})

describe('MarksState', () => {
  const big: MarksTable = buildScreenMarks({ nodes: grid(150, 12), area: AREA })

  it('pages at 99 and renumbers each page from 1', () => {
    expect(big).toHaveLength(150)
    const s = new MarksState()
    s.show(big)
    expect(s.pages).toBe(2)
    expect(s.visible()).toHaveLength(PAGE_SIZE)
    expect(s.find(99)?.label).toBe(big[98].label)
    expect(s.nextPage()).toBe(true)
    const page2 = s.visible()
    expect(page2).toHaveLength(51)
    expect(page2[0].n).toBe(1)
    expect(s.find(1)?.label).toBe(big[99].label)
    expect(s.find(52)).toBeUndefined()
    expect(s.nextPage()).toBe(true)
    expect(s.page).toBe(0)
  })

  it('has no next page with one page and finds nothing once hidden', () => {
    const s = new MarksState()
    s.show(big.slice(0, 10))
    expect(s.nextPage()).toBe(false)
    expect(s.find(3)).toBeDefined()
    s.hide()
    expect(s.shown).toBe(false)
    expect(s.find(3)).toBeUndefined()
  })

  it('is not shown for an empty table', () => {
    const s = new MarksState()
    s.show([])
    expect(s.shown).toBe(false)
  })
})

describe('findByName', () => {
  const nodes = [
    node('Compose', { x: 10, y: 10, w: 80, h: 20 }),
    node('Send', { x: 100, y: 10, w: 80, h: 20 }),
    node('Reply', { x: 200, y: 10, w: 80, h: 20 }),
    node('Reply', { x: 300, y: 10, w: 80, h: 20 }),
    node('Compose', { x: 400, y: 10, w: 80, h: 20 }, 'text', [])
  ]

  it('matches one exact name, ignoring case, articles and a role word', () => {
    expect(findByName(nodes, 'compose')?.name).toBe('Compose')
    expect(findByName(nodes, 'the Send button')?.name).toBe('Send')
  })

  it('returns null for ambiguous, partial or unknown names', () => {
    expect(findByName(nodes, 'reply')).toBeNull()
    expect(findByName(nodes, 'comp')).toBeNull()
    expect(findByName(nodes, 'archive')).toBeNull()
    expect(findByName(nodes, 'the')).toBeNull()
  })
})
