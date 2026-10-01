import { describe, expect, it } from 'vitest'
import { moveIndex } from '../src/renderer/src/panel/home/suggestions'

describe('home suggestion focus', () => {
  it('moves and wraps with arrows', () => {
    expect(moveIndex(0, 'ArrowRight', 3)).toBe(1)
    expect(moveIndex(2, 'ArrowRight', 3)).toBe(0)
    expect(moveIndex(0, 'ArrowLeft', 3)).toBe(2)
    expect(moveIndex(1, 'ArrowDown', 3)).toBe(2)
  })
  it('jumps with Home/End and ignores other keys', () => {
    expect(moveIndex(1, 'Home', 3)).toBe(0)
    expect(moveIndex(1, 'End', 3)).toBe(2)
    expect(moveIndex(1, 'Tab', 3)).toBeNull()
    expect(moveIndex(0, 'ArrowRight', 0)).toBeNull()
  })
})
