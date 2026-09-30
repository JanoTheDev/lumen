import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createDraftCommitter,
  isHexColor,
  parseClamped,
  DRAFT_DEBOUNCE_MS
} from '../src/renderer/src/settings/draft'

describe('createDraftCommitter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('typing a phrase commits exactly once after the pause', () => {
    const commit = vi.fn()
    const d = createDraftCommitter('hey lumen', commit)
    let typed = ''
    for (const ch of 'hey computer') {
      typed += ch
      d.set(typed)
      vi.advanceTimersByTime(80)
    }
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('hey computer')
  })

  it('flush commits immediately and does not repeat', () => {
    const commit = vi.fn()
    const d = createDraftCommitter('a', commit)
    d.set('ab')
    d.flush()
    d.flush()
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('does not commit an unchanged value', () => {
    const commit = vi.fn()
    const d = createDraftCommitter('same', commit)
    d.set('samex')
    d.set('same')
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    expect(commit).not.toHaveBeenCalled()
  })

  it('skips values the accept check rejects', () => {
    const commit = vi.fn()
    const d = createDraftCommitter('#000000', commit, { accept: isHexColor })
    d.set('#12')
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS)
    expect(commit).not.toHaveBeenCalled()
    d.set('#123abc')
    d.flush()
    expect(commit).toHaveBeenCalledWith('#123abc')
  })

  it('sync adopts an external value without committing', () => {
    const commit = vi.fn()
    const d = createDraftCommitter('a', commit)
    d.sync('b')
    expect(d.get()).toBe('b')
    d.flush()
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('isHexColor', () => {
  it.each(['#5b8cff', '#FFFFFF', '#000000'])('accepts %s', (v) => expect(isHexColor(v)).toBe(true))
  it.each(['#fff', '5b8cff', '#5b8cf', '#5b8cffa', '#ggg000', ''])('rejects %s', (v) =>
    expect(isHexColor(v)).toBe(false)
  )
})

describe('parseClamped', () => {
  it('lets 1500 through in a min-400 field', () => {
    expect(parseClamped('1500', 400, 5000)).toBe(1500)
  })
  it('clamps out of range', () => {
    expect(parseClamped('1', 400, 5000)).toBe(400)
    expect(parseClamped('99999', 400, 5000)).toBe(5000)
  })
  it('returns null for non-numbers', () => {
    expect(parseClamped('', 0, 10)).toBeNull()
    expect(parseClamped('abc', 0, 10)).toBeNull()
  })
})
