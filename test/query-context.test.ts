import { describe, it, expect, vi } from 'vitest'
import { startSpeculativeCapture, takeSpeculative, clearSpeculative } from '../src/main/query/context'

describe('speculative context', () => {
  it('reuses the in-flight capture once', async () => {
    const capture = vi.fn(async () => ({ activeWindow: 'Notepad', screenshot: 'img' }))
    startSpeculativeCapture(capture)
    const p = takeSpeculative()
    expect(p).not.toBeNull()
    await expect(p).resolves.toEqual({ activeWindow: 'Notepad', screenshot: 'img' })
    expect(takeSpeculative()).toBeNull()
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('ignores stale captures', () => {
    startSpeculativeCapture(async () => ({ activeWindow: 'x', screenshot: null }))
    expect(takeSpeculative(Date.now() + 5000)).toBeNull()
  })

  it('surfaces capture failures to the consumer only', async () => {
    startSpeculativeCapture(async () => {
      throw new Error('agent down')
    })
    await expect(takeSpeculative()).rejects.toThrow('agent down')
    clearSpeculative()
  })
})
