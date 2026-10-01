import { describe, expect, it, vi } from 'vitest'
import { PointerRing } from '../../src/main/deictic/buffer'
import { wordTimes } from '../../src/main/deictic/align'
import { parseDeictic, words } from '../../src/main/deictic/grammar'
import { Deictic, type DeicticDeps } from '../../src/main/deictic/core'

describe('PointerRing', () => {
  it('keeps the last N samples in order', () => {
    const r = new PointerRing(3)
    for (let i = 0; i < 5; i++) r.push({ t: i, x: i, y: 0 })
    expect(r.samples().map((s) => s.t)).toEqual([2, 3, 4])
  })

  it('at() is the sample at or before t', () => {
    const r = new PointerRing()
    r.push({ t: 100, x: 1, y: 1 })
    r.push({ t: 200, x: 2, y: 2 })
    expect(r.at(150)).toEqual({ x: 1, y: 1 })
    expect(r.at(50)).toBeNull()
  })

  it('heldNear() picks the position held longest around t', () => {
    const r = new PointerRing()
    // Moving fast 0-300 ms, resting at (50,50) 300-1300 ms, then moving away.
    for (let t = 0; t < 300; t += 16) r.push({ t, x: t, y: t })
    r.push({ t: 300, x: 50, y: 50 })
    for (let t = 1300; t < 1500; t += 16) r.push({ t, x: 900, y: t })
    expect(r.heldNear(700, 500, 2000)).toEqual({ x: 50, y: 50 })
    // The estimate is off by 400 ms: still the rest point.
    expect(r.heldNear(1100, 500, 2000)).toEqual({ x: 50, y: 50 })
  })
})

describe('wordTimes', () => {
  it('spreads words over the speech after a lead-in', () => {
    const ws = words('move this there')
    const t = wordTimes(ws, { start: 0, end: 3000 })
    expect(t).toHaveLength(3)
    expect(t[0].t).toBeGreaterThan(300)
    expect(t[1].t).toBeGreaterThan(t[0].t)
    expect(t[2].t).toBeLessThan(2750)
  })

  it('uses engine word times when they fit', () => {
    const t = wordTimes(['click', 'this'], {
      start: 0,
      end: 2000,
      words: [
        { start: 100, end: 300 },
        { start: 900, end: 1100 }
      ]
    })
    expect(t[1].t).toBe(1000)
  })
})

describe('parseDeictic', () => {
  it.each([
    ['click this', 'click'],
    ['Click on that.', 'click'],
    ['double click here', 'click'],
    ['right-click this', 'click'],
    ['move this there', 'drag'],
    ['put that over here', 'drag'],
    ['drag this to there', 'drag'],
    ["what's that?", 'what'],
    ['what does this button do', 'what'],
    ['what is this', 'what']
  ])('%s → %s', (u, kind) => {
    expect(parseDeictic(u)?.kind).toBe(kind)
  })

  it('ignores other commands', () => {
    expect(parseDeictic('click save')).toBeNull()
    expect(parseDeictic('what is this error')).toBeNull()
    expect(parseDeictic('move this window to the left monitor please now')).toBeNull()
  })

  it('finds the pointing words', () => {
    expect(parseDeictic('move this there')).toEqual({ kind: 'drag', refs: [1, 2] })
    expect(parseDeictic('right click that')).toMatchObject({ button: 'right', refs: [2] })
  })
})

interface Setup {
  d: Deictic
  run: ReturnType<typeof vi.fn>
  at: (t: number) => number
}

function setup(over: Partial<DeicticDeps> = {}): Setup {
  let now = 0
  const run = vi.fn(async () => ({ ok: true }))
  const deps: DeicticDeps = {
    now: () => now,
    enabled: () => true,
    cursor: () => ({ x: 999, y: 999 }),
    run,
    explain: vi.fn(async (p) => `thing at ${p.x},${p.y}`),
    log: () => {},
    handled: 'HANDLED',
    ...over
  }
  const d = new Deictic(deps)
  return { d, run, at: (t: number) => (now = t) }
}

describe('Deictic', () => {
  it('drags between where the pointer was at "this" and at "there"', async () => {
    const { d, run, at } = setup()
    at(0)
    d.onVoiceStarted()
    d.onPointer({ x: 10, y: 10 })
    at(1700)
    d.onPointer({ x: 400, y: 300 })
    at(2600)
    d.onVoiceStopped()
    expect(await d.intercept('move this there')).toBe('HANDLED')
    expect(run).toHaveBeenCalledWith(
      [{ type: 'input', steps: [{ t: 'drag', from: { x: 10, y: 10 }, to: { x: 400, y: 300 } }] }],
      'move this there'
    )
  })

  it('a typed "click this" clicks where the pointer is now', async () => {
    const { d, run } = setup()
    await d.intercept('click this')
    expect(run.mock.calls[0][0]).toEqual([
      { type: 'input', steps: [{ t: 'click', button: 'left', x: 999, y: 999 }] }
    ])
  })

  it('a typed "click this" after an unrelated voice turn uses the pointer now (review med)', async () => {
    const { d, run, at } = setup()
    at(0)
    d.onVoiceStarted()
    d.onPointer({ x: 10, y: 10 })
    at(2000)
    d.onVoiceStopped()
    // The spoken turn: not a deictic command, it consumes the recording's timing.
    expect(d.intercept("what's the weather")).toBeUndefined()
    at(12_000)
    await d.intercept('click this')
    expect(run.mock.calls[0][0]).toEqual([
      { type: 'input', steps: [{ t: 'click', button: 'left', x: 999, y: 999 }] }
    ])
  })

  it('a typed "move this there" asks to say it while pointing', () => {
    const { d, run } = setup()
    expect(d.intercept('move this there')).toMatchObject({ mode: 'answer' })
    expect(run).not.toHaveBeenCalled()
  })

  it('"what\'s that" explains the point', async () => {
    const { d } = setup()
    expect(await d.intercept("what's that")).toEqual({
      mode: 'answer',
      text: 'thing at 999,999'
    })
  })

  it('leaves "what is this" about dropped files to the assistant', () => {
    const { d } = setup({ aboutFiles: (_u, pointed) => !pointed })
    expect(d.intercept("what's this")).toBeUndefined()
    d.onPointer({ x: 1, y: 1 })
    expect(d.intercept("what's this")).toBeDefined()
    expect(d.intercept('click this')).toBeDefined()
  })

  it('does nothing while off', () => {
    const { d } = setup({ enabled: () => false })
    expect(d.intercept('click this')).toBeUndefined()
  })

  it('reports a denied action', async () => {
    const { d } = setup({ run: async () => ({ ok: false, why: 'no' }) })
    expect(await d.intercept('click this')).toEqual({ mode: 'answer', text: 'no' })
  })
})
