import { describe, expect, it } from 'vitest'
import { seedOf, shapeFor } from '../../src/renderer/src/screen/annotate'

describe('annotation shapes', () => {
  const pts = [
    { x: 100, y: 100 },
    { x: 300, y: 220 }
  ]

  it('draws an arrow as a shaft plus two head strokes', () => {
    const s = shapeFor('arrow', pts)
    expect(s.strokes.length).toBeGreaterThanOrEqual(3)
    expect(s.strokes.every((d) => d.startsWith('M'))).toBe(true)
  })

  it('draws the same wobble for the same points', () => {
    expect(shapeFor('circle', pts)).toEqual(shapeFor('circle', pts))
    expect(seedOf(pts)).not.toBe(seedOf([{ x: 1, y: 2 }]))
  })

  it('fills scribbles and leaves text to the label layer', () => {
    expect(shapeFor('scribble', pts).fill).toMatch(/^M .* Z$/)
    expect(shapeFor('text', pts).strokes).toEqual([])
  })
})
