import { describe, expect, it } from 'vitest'
import { PointerRing } from '../../src/main/deictic/buffer'
import { Deictic, type DeicticDeps } from '../../src/main/deictic/core'

function setup(): { d: Deictic; at: (t: number) => void } {
  let now = 0
  const deps: DeicticDeps = {
    now: () => now,
    enabled: () => true,
    cursor: () => ({ x: 999, y: 999 }),
    run: async () => ({ ok: true }),
    explain: async () => '',
    log: () => {},
    handled: 'HANDLED'
  }
  return { d: new Deictic(deps), at: (t) => (now = t) }
}

describe('PointerRing.circled', () => {
  it('is the middle of a small loop', () => {
    const r = new PointerRing()
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 4
      r.push({ t: 1000 + i * 30, x: 500 + Math.cos(a) * 30, y: 300 + Math.sin(a) * 20 })
    }
    const p = r.circled(900, 2300)
    expect(p).not.toBeNull()
    expect(Math.abs(p!.x - 500)).toBeLessThan(3)
    expect(Math.abs(p!.y - 300)).toBeLessThan(3)
  })

  it('is null for a sweep across the screen or a still pointer', () => {
    const r = new PointerRing()
    for (let i = 0; i < 40; i++) r.push({ t: i * 30, x: i * 20, y: 100 })
    expect(r.circled(0, 1200)).toBeNull()
    const still = new PointerRing()
    for (let i = 0; i < 40; i++) still.push({ t: i * 30, x: 10, y: 10 })
    expect(still.circled(0, 1200)).toBeNull()
  })
})

describe('Deictic.pointFor ("this file")', () => {
  it('uses the circling while the user spoke, also after a non-deictic intercept', () => {
    const { d, at } = setup()
    at(0)
    d.onVoiceStarted()
    // Away first, then circling a file icon at (800, 400) while talking.
    for (let t = 0; t < 400; t += 30) {
      at(t)
      d.onPointer({ x: 100 + t, y: 100 })
    }
    for (let i = 0; i < 50; i++) {
      at(400 + i * 30)
      const a = (i / 50) * Math.PI * 6
      d.onPointer({ x: 800 + Math.cos(a) * 25, y: 400 + Math.sin(a) * 15 })
    }
    at(2000)
    d.onVoiceStopped()
    at(2100)
    // The deictic grammar does not take "summarize this file": its timing is kept for it.
    expect(d.intercept('summarize this file')).toBeUndefined()
    const p = d.pointFor('summarize this file')
    expect(Math.abs(p.x - 800)).toBeLessThan(5)
    expect(Math.abs(p.y - 400)).toBeLessThan(5)
  })

  it('takes where the pointer rested around "this" when it did not circle', () => {
    const { d, at } = setup()
    at(0)
    d.onVoiceStarted()
    d.onPointer({ x: 40, y: 40 })
    at(300)
    d.onPointer({ x: 640, y: 220 })
    at(2600)
    d.onPointer({ x: 1500, y: 900 })
    at(3000)
    d.onVoiceStopped()
    expect(d.pointFor('convert this to excel')).toEqual({ x: 640, y: 220 })
  })

  it('is the pointer now for a typed request', () => {
    const { d } = setup()
    expect(d.pointFor('summarize this file')).toEqual({ x: 999, y: 999 })
  })
})
