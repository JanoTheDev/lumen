import { describe, expect, it } from 'vitest'
import type { InputStep } from '../../src/shared/types'
import type { LessonCommand } from '../../src/shared/events'
import { MouseGrid } from '../../src/main/a11y/grid'
import { ScanTree, type ScanMark, type ScanTreeDeps } from '../../src/main/a11y/scan-tree'
import type { ScanItem, ScanLevel, ScanResult } from '../../src/main/a11y/switch'

interface Fake {
  tree: ScanTree
  input: InputStep[][]
  said: string[]
  lessonCmds: LessonCommand[]
  ran: string[]
  grid: MouseGrid
  kb: ScanLevel
  hidden: () => number
}

function fake(marks: ScanMark[] = [], lesson = false): Fake {
  const input: InputStep[][] = []
  const said: string[] = []
  const lessonCmds: LessonCommand[] = []
  const ran: string[] = []
  let shown: ScanMark[] = []
  let hidden = 0
  const grid = new MouseGrid()
  const kb: ScanLevel = { title: 'Keyboard', items: [] }
  const deps: ScanTreeDeps = {
    showNumbers: async () => {
      shown = marks
      return marks.length
    },
    numbers: () => shown,
    hideNumbers: () => {
      hidden++
      shown = []
    },
    showGrid: () => grid.show({ x: 0, y: 0, w: 900, h: 900 }, 1),
    grid: () => grid.scene(),
    gridSelect: (n) => grid.select(n),
    gridUp: () => grid.up(),
    gridAtMinimum: () => grid.atMinimum,
    closeGrid: () => grid.close(),
    input: async (steps) => {
      input.push(steps)
    },
    // Physical = logical × 2.
    logicalToPhys: (p) => ({ x: p.x * 2, y: p.y * 2 }),
    keyboard: () => kb,
    lumenActions: () => [{ label: 'Ask', run: () => ran.push('ask') }],
    lessonRunning: () => lesson,
    lessonCommand: (c) => lessonCmds.push(c),
    feedback: (t) => said.push(t)
  }
  return {
    tree: new ScanTree(deps),
    input,
    said,
    lessonCmds,
    ran,
    grid,
    kb,
    hidden: () => hidden
  }
}

const labels = (l: ScanLevel): string[] => l.items.map((i) => i.label)
const find = (l: ScanLevel, label: string): ScanItem => {
  const it = l.items.find((i) => i.label === label)
  if (!it) throw new Error(`no item ${label} in ${labels(l)}`)
  return it
}
const pushed = (r: ScanResult): ScanLevel => {
  if (typeof r === 'object' && 'push' in r) return r.push
  throw new Error(`expected push, got ${JSON.stringify(r)}`)
}

const mark = (n: number, x: number, y: number, label = `m${n}`): ScanMark => ({
  n,
  label,
  rect: { x, y, w: 40, h: 20 }
})

describe('ScanTree', () => {
  it('root lists Lumen, numbers, grid and keyboard; Lesson first while a lesson runs', () => {
    expect(labels(fake().tree.root())).toEqual(['Lumen', 'Numbers', 'Mouse grid', 'Keyboard'])
    expect(labels(fake([], true).tree.root())[0]).toBe('Lesson')
  })

  it('lesson items emit lesson commands', async () => {
    const f = fake([], true)
    const lesson = pushed(await find(f.tree.root(), 'Lesson').select())
    expect(await find(lesson, 'Do it for me').select()).toBe('root')
    expect(f.lessonCmds).toEqual(['do-it'])
  })

  it('Lumen actions run and go back to the top', async () => {
    const f = fake()
    const lumen = pushed(await find(f.tree.root(), 'Lumen').select())
    expect(await find(lumen, 'Ask').select()).toBe('root')
    expect(f.ran).toEqual(['ask'])
  })

  it('numbers: rows of marks, then marks, then an action menu that clicks the centre', async () => {
    const marks = [mark(1, 0, 0, 'File'), mark(2, 50, 0, 'Edit'), mark(3, 0, 100, 'Save')]
    const f = fake(marks)
    const rows = pushed(await find(f.tree.root(), 'Numbers').select())
    expect(labels(rows)).toEqual(['Row 1, File', 'Row 2, Save'])
    expect(rows.items[0].rect).toEqual({ x: 0, y: 0, w: 90, h: 20 })
    const row1 = pushed(await rows.items[0].select())
    expect(labels(row1)).toEqual(['1, File', '2, Edit'])
    expect(row1.items[1].n).toBe(2)
    const menu = pushed(await row1.items[1].select())
    expect(labels(menu)).toEqual([
      'Click',
      'Double click',
      'Right click',
      'Start drag here',
      'Scroll',
      'Type here'
    ])
    expect(await find(menu, 'Double click').select()).toBe('root')
    expect(f.input).toEqual([[{ t: 'click', button: 'left', count: 2, x: 140, y: 20 }]])
    rows.onExit?.()
    expect(f.hidden()).toBe(1)
  })

  it('numbers: one row skips the row level; none says so and stays', async () => {
    const one = fake([mark(1, 0, 0), mark(2, 50, 0)])
    expect(labels(pushed(await find(one.tree.root(), 'Numbers').select()))).toEqual([
      '1, m1',
      '2, m2'
    ])
    const none = fake([])
    expect(await find(none.tree.root(), 'Numbers').select()).toBe('stay')
    expect(none.said).toEqual(['Nothing to number here'])
  })

  it('grid: a cell zooms in place (replace), Zoom out goes up, the minimum opens actions', async () => {
    const f = fake()
    const g0 = pushed(await find(f.tree.root(), 'Mouse grid').select())
    expect(labels(g0)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Act here'])
    expect(g0.items[4].rect).toEqual({ x: 300, y: 300, w: 300, h: 300 })
    const r = await g0.items[4].select()
    expect(typeof r === 'object' && 'replace' in r).toBe(true)
    const g1 = (r as { replace: ScanLevel }).replace
    expect(labels(g1)).toContain('Zoom out')
    expect(g1.items[0].rect).toEqual({ x: 300, y: 300, w: 100, h: 100 })
    // Zoom until the cells are at the minimum, then a cell opens the action menu.
    let level = g1
    for (let i = 0; i < 6; i++) {
      const next = await level.items[0].select()
      if (typeof next === 'object' && 'push' in next) {
        expect(next.push.title).toMatch(/^Action on cell 1/)
        break
      }
      level = (next as { replace: ScanLevel }).replace
    }
    expect(f.grid.atMinimum).toBe(true)
    g0.onExit?.()
    expect(f.grid.shown).toBe(false)
  })

  it('drag: start here, then Drop here leads every action menu', async () => {
    const f = fake()
    const menu = f.tree.actionMenu({ x: 10, y: 10 }, 'here')
    expect(await find(menu, 'Start drag here').select()).toBe('root')
    expect(f.tree.root().title).toBe('Pick where to drop')
    const menu2 = f.tree.actionMenu({ x: 100, y: 50 }, 'there')
    expect(menu2.items[0].label).toBe('Drop here')
    await menu2.items[0].select()
    expect(f.input).toEqual([[{ t: 'drag', from: { x: 20, y: 20 }, to: { x: 200, y: 100 } }]])
    expect(f.tree.dragFrom).toBeNull()
  })

  it('scroll scrolls at the point and stays; Type here clicks, then opens the keyboard', async () => {
    const f = fake()
    const menu = f.tree.actionMenu({ x: 10, y: 20 }, 'here')
    const scroll = pushed(await find(menu, 'Scroll').select())
    expect(await find(scroll, 'Scroll down').select()).toBe('stay')
    expect(f.input[0]).toEqual([{ t: 'scroll', dx: 0, dy: 5, x: 20, y: 40 }])
    expect(pushed(await find(menu, 'Type here').select())).toBe(f.kb)
    expect(f.input[1]).toEqual([{ t: 'click', button: 'left', x: 20, y: 40 }])
  })
})
