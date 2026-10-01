import { describe, it, expect } from 'vitest'
import { parseBlocks } from '../src/renderer/src/ui/md-parse'

describe('parseBlocks', () => {
  it('splits paragraphs, lists, headings and code', () => {
    const blocks = parseBlocks('# Title\nline one\nline two\n\n- a\n- b\n1. x\n```\ncode\n```')
    expect(blocks).toEqual([
      { kind: 'h', text: 'Title' },
      { kind: 'p', text: 'line one line two' },
      { kind: 'ul', items: ['a', 'b'] },
      { kind: 'ol', items: ['x'] },
      { kind: 'code', text: 'code' }
    ])
  })

  it('keeps an unclosed fence open while streaming', () => {
    expect(parseBlocks('text\n```\nconst a = 1')).toEqual([
      { kind: 'p', text: 'text' },
      { kind: 'code', text: 'const a = 1' }
    ])
  })

  it('passes raw HTML through as text', () => {
    expect(parseBlocks('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'p', text: '<img src=x onerror=alert(1)>' }
    ])
  })
})
