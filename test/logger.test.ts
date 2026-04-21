import { describe, it, expect, vi, beforeEach } from 'vitest'
import { log } from '../src/main/logger'

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('formats [plan] tag with message', () => {
    log('plan', 'task: open gmail')
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[plan]')
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('task: open gmail')
    )
  })

  it('includes model when provided', () => {
    log('verify', 'page changed', { model: 'gpt-5-nano' })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('gpt-5-nano')
    )
  })

  it('formats cost to 5 decimal places', () => {
    log('done', 'complete', { cost: 0.00123 })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('$0.00123')
    )
  })

  it('formats timeMs as seconds', () => {
    log('step', 'navigate', { timeMs: 2500 })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('2.5s')
    )
  })
})
