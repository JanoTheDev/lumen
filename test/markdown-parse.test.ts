import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { parseBlocks } from '../src/renderer/src/ui/md-parse'
import { Markdown } from '../src/renderer/src/ui/Markdown'

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

describe('Markdown markup', () => {
  it('renders each block, one span per word while streaming', () => {
    const source =
      '# Hi\n\nSome **bold** and [x](https://a.b) `c`\n\n- a\n- b\n\n1. one\n\n```\ncode\n```'
    expect(
      renderToStaticMarkup(createElement(Markdown, { source, streaming: true, className: 'k' }))
    ).toBe(
      '<div class="ui-md k" aria-busy="true"><p class="ui-md__h"><strong><span class="ui-md__w">Hi</span></strong></p><p><span class="ui-md__w">Some</span> <strong><span class="ui-md__w">bold</span></strong> <span class="ui-md__w">and</span> <a href="https://a.b">x</a> <code>c</code></p><ul><li><span class="ui-md__w">a</span></li><li><span class="ui-md__w">b</span></li></ul><ol><li><span class="ui-md__w">one</span></li></ol><pre><code>code</code></pre></div>'
    )
  })

  it('renders plain text when done and drops unsafe links', () => {
    const source = 'p1 _e_ **b**\n\np2 [bad](javascript:x)\n\n```\nopen'
    expect(renderToStaticMarkup(createElement(Markdown, { source }))).toBe(
      '<div class="ui-md"><p>p1 <em>e</em> <strong>b</strong></p><p>p2 bad</p><pre><code>open</code></pre></div>'
    )
    expect(renderToStaticMarkup(createElement(Markdown, { source: '' }))).toBe(
      '<div class="ui-md"></div>'
    )
  })
})
