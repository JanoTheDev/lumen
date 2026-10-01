import { describe, expect, it } from 'vitest'
import { placeBadge } from '../../src/renderer/src/a11y/place'

const BADGE = { w: 24, h: 26 }
const VIEW = { w: 1920, h: 1080 }

describe('placeBadge', () => {
  it('goes outside the top-left corner when there is room', () => {
    expect(placeBadge({ x: 100, y: 100, w: 80, h: 30 }, BADGE, VIEW)).toBe('above-left')
  })
  it('goes to the left at the top edge', () => {
    expect(placeBadge({ x: 100, y: 4, w: 80, h: 30 }, BADGE, VIEW)).toBe('left')
  })
  it('goes above at the left edge', () => {
    expect(placeBadge({ x: 2, y: 100, w: 80, h: 30 }, BADGE, VIEW)).toBe('above')
  })
  it('goes inside in the top-left corner', () => {
    expect(placeBadge({ x: 0, y: 0, w: 80, h: 30 }, BADGE, VIEW)).toBe('inside')
  })
})
