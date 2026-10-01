import { describe, expect, it } from 'vitest'
import { formatSize, isFileDrag } from '../../src/renderer/src/assistant/files'

describe('bar file chips', () => {
  it('formats sizes', () => {
    expect(formatSize(812)).toBe('812 B')
    expect(formatSize(340 * 1024)).toBe('340 KB')
    expect(formatSize(2.1 * 1024 * 1024)).toBe('2.1 MB')
    expect(formatSize(48 * 1024 * 1024)).toBe('48 MB')
  })

  it('reacts only to file drags', () => {
    expect(isFileDrag(['Files'])).toBe(true)
    expect(isFileDrag(['text/plain', 'text/uri-list'])).toBe(false)
    expect(isFileDrag(undefined)).toBe(false)
  })
})
