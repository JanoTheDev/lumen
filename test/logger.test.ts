import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log } from '../src/main/logger'

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('pads tag to 9 characters', () => {
    log('plan', 'msg')
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/\[plan\]\s{3}/)  // [plan] = 6 chars, padded to 9 = 3 spaces
    )
    vi.clearAllMocks()
    log('verify', 'msg')
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/\[verify\]\s{1}/)  // [verify] = 8 chars, padded to 9 = 1 space
    )
  })

  it('prepends wall-clock timestamp HH:MM:SS.mmm', () => {
    log('plan', 'msg')
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{2}:\d{2}:\d{2}\.\d{3}\s\[plan\]/)
    )
  })

  it('includes model with pipe separator', () => {
    log('verify', 'page changed', { model: 'gpt-5-nano' })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('| gpt-5-nano')
    )
  })

  it('formats cost to 5 decimal places (trailing zeros)', () => {
    log('done', 'complete', { cost: 0.001 })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('$0.00100')
    )
  })

  it('formats timeMs as seconds with pipe separator', () => {
    log('step', 'navigate', { timeMs: 2500 })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('| 2.50s')
    )
  })

  it('assembles full format with all meta fields', () => {
    log('verify', 'done', { model: 'gpt-5-nano', cost: 0.00008, timeMs: 1200 })
    const call = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(call).toMatch(/\[verify\]/)
    expect(call).toContain('done')
    expect(call).toContain('| gpt-5-nano')
    expect(call).toContain('| $0.00008')
    expect(call).toContain('| 1.20s')
  })
})
