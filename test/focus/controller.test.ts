import { describe, expect, it, vi } from 'vitest'
import type { FocusScene } from '../../src/shared/events'
import { FocusController, type FocusIo } from '../../src/main/focus/controller'

interface Setup {
  c: FocusController
  drawn: (FocusScene | null)[]
  move: (r: { x: number; y: number; w: number; h: number }) => void
}

function setup(opts: { regions?: boolean; auto?: boolean; win?: boolean } = {}): Setup {
  const drawn: (FocusScene | null)[] = []
  let rect = { x: 0, y: 0, w: 1000, h: 800 }
  const io: FocusIo = {
    foreground: vi.fn(async () => (opts.win === false ? null : { rect, process: 'blender.exe' })),
    regions: () =>
      opts.regions
        ? {
            viewport: { x: 0, y: 0, w: 0.5, h: 0.5, desc: '3D Viewport' },
            outliner: { x: 0.5, y: 0, w: 0.5, h: 0.5, desc: 'Outliner, top right' }
          }
        : null,
    physRectToLogical: (r) => ({ x: r.x / 2, y: r.y / 2, w: r.w / 2, h: r.h / 2 }),
    draw: (s) => drawn.push(s),
    level: () => 'soft',
    autoWithLessons: () => !!opts.auto
  }
  return {
    c: new FocusController(io),
    drawn,
    move: (r) => {
      rect = r
    }
  }
}

describe('FocusController', () => {
  it('"focus mode on" keeps the foreground window (logical px)', async () => {
    const { c, drawn } = setup()
    const r = await c.on()
    expect(r.ok).toBe(true)
    expect(drawn[0]?.keep[0]).toEqual({ x: -8, y: -8, w: 516, h: 416 })
    expect(c.active).toBe(true)
  })

  it('"only show the viewport" keeps the region and strong labels the rest', async () => {
    const { c, drawn } = setup({ regions: true })
    await c.on({ region: 'viewport', level: 'strong' })
    expect(drawn[0]?.keep).toHaveLength(1)
    expect(drawn[0]?.labels?.map((l) => l.text)).toEqual(['Hidden: Outliner'])
  })

  it('an unknown area is refused with the names it knows', async () => {
    const { c, drawn } = setup({ regions: true })
    const r = await c.on({ region: 'timeline' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('viewport, outliner')
    expect(drawn).toEqual([])
  })

  it('no window in front: stays off', async () => {
    const { c } = setup({ win: false })
    expect((await c.on()).ok).toBe(false)
    expect(c.active).toBe(false)
  })

  it('"show everything" clears it', async () => {
    const { c, drawn } = setup()
    await c.on()
    expect(c.off().text).toBe('Showing everything.')
    expect(drawn.at(-1)).toBeNull()
    expect(c.active).toBe(false)
  })

  it('follows the window when it moves', async () => {
    const { c, drawn, move } = setup()
    await c.on()
    await c.refresh()
    expect(drawn).toHaveLength(1)
    move({ x: 200, y: 0, w: 1000, h: 800 })
    await c.refresh()
    expect(drawn).toHaveLength(2)
    expect(drawn[1]?.keep[0].x).toBe(92)
  })

  it('lesson targets drive focus only when the setting is on', () => {
    const off = setup()
    off.c.lessonTargets([{ x: 10, y: 10, w: 50, h: 20 }])
    expect(off.drawn).toEqual([])
    const on = setup({ auto: true })
    on.c.lessonTargets([{ x: 10, y: 10, w: 50, h: 20 }])
    expect(on.drawn[0]?.keep).toHaveLength(1)
    on.c.lessonTargets(null)
    expect(on.drawn.at(-1)).toBeNull()
  })

  it('a manual focus is not replaced by a lesson step', async () => {
    const { c, drawn } = setup({ auto: true })
    await c.on()
    c.lessonTargets([{ x: 10, y: 10, w: 50, h: 20 }])
    expect(drawn).toHaveLength(1)
  })
})
