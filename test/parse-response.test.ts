import { describe, it, expect } from 'vitest'
import { extractFirstJson, parseResponse } from '../src/main/claude'

const SORRY = "Sorry, I couldn't process that."

describe('extractFirstJson', () => {
  it('ignores closing braces inside strings', () => {
    const s = '{"mode":"answer","text":"a}"}'
    expect(extractFirstJson(s)).toBe(s)
  })

  it('ignores opening braces inside strings', () => {
    const s = '{"text":"{{{"}'
    expect(extractFirstJson(s)).toBe(s)
  })

  it('handles escaped quotes inside strings', () => {
    const s = '{"text":"say \\"}\\" now"}'
    expect(extractFirstJson(s)).toBe(s)
    expect(JSON.parse(extractFirstJson(s)!).text).toBe('say "}" now')
  })

  it('handles escaped backslash before closing quote', () => {
    const s = '{"path":"C:\\\\"}'
    expect(extractFirstJson(s + ' trailing}')).toBe(s)
  })

  it('returns only the first of two concatenated objects', () => {
    expect(extractFirstJson('{"a":1}{"b":2}')).toBe('{"a":1}')
  })

  it('skips prose before the first brace', () => {
    expect(extractFirstJson('Sure! Here you go: {"a":{"b":"}"}} bye')).toBe('{"a":{"b":"}"}}')
  })

  it('returns null without a complete object', () => {
    expect(extractFirstJson('no json here')).toBeNull()
    expect(extractFirstJson('{"a":"unterminated}')).toBeNull()
  })
})

describe('parseResponse', () => {
  it('parses a plain answer', () => {
    expect(parseResponse('{"mode":"answer","text":"hello"}')).toEqual({
      mode: 'answer',
      text: 'hello'
    })
  })

  it('parses text containing braces', () => {
    const r = parseResponse('{"mode":"answer","text":"use a}b"}')
    expect(r).toEqual({ mode: 'answer', text: 'use a}b' })
  })

  it('strips code fences', () => {
    expect(parseResponse('```json\n{"mode":"answer","text":"hi"}\n```')).toEqual({
      mode: 'answer',
      text: 'hi'
    })
  })

  it('strips prose preceding the JSON', () => {
    const r = parseResponse(
      'Here is the plan:\n{"mode":"action","actions":[{"type":"open_url","url":"https://example.com"}]}'
    )
    expect(r.mode).toBe('action')
  })

  it('keeps the first of double JSON', () => {
    const r = parseResponse('{"mode":"answer","text":"one"}{"mode":"answer","text":"two"}')
    expect(r).toEqual({ mode: 'answer', text: 'one' })
  })

  it('returns an apology instead of raw broken JSON', () => {
    expect(parseResponse('not valid json {{{}')).toEqual({ mode: 'answer', text: SORRY })
    expect(parseResponse('{"mode":"action","actions":[')).toEqual({ mode: 'answer', text: SORRY })
    expect(parseResponse('{"foo":1}')).toEqual({ mode: 'answer', text: SORRY })
  })

  it('keeps plain prose answers', () => {
    expect(parseResponse('The capital of France is Paris.')).toEqual({
      mode: 'answer',
      text: 'The capital of France is Paris.'
    })
  })

  it('returns an apology for empty output', () => {
    expect(parseResponse('   ')).toEqual({ mode: 'answer', text: SORRY })
  })

  it('unwraps JSON nested in answer text', () => {
    const inner = '{"mode":"action","actions":[{"type":"click","x":1,"y":2}]}'
    const r = parseResponse(JSON.stringify({ mode: 'answer', text: inner }))
    expect(r.mode).toBe('action')
  })

  it('treats a bare action object as an action', () => {
    const r = parseResponse('{"type":"type","text":"hi"}')
    expect(r.mode).toBe('action')
  })

  it('filters locate items without a valid bbox', () => {
    const r = parseResponse(
      JSON.stringify({
        mode: 'locate',
        items: [
          { label: 'ok', bbox: { x: 10, y: 20, w: 30, h: 40 } },
          { label: 'legacy', bbox: [10, 20, 110, 60] },
          { label: 'none' },
          { label: 'short', bbox: [1, 2, 3] },
          { label: 'nan', bbox: [1, 2, 'x', 4] },
          { label: 'zero', bbox: [1, 2, 0, 4] }
        ]
      })
    )
    expect(r.mode).toBe('locate')
    if (r.mode === 'locate') expect(r.items.map((i) => i.label)).toEqual(['ok', 'legacy'])
    if (r.mode === 'locate') expect(r.items[1].bbox).toEqual({ x: 10, y: 20, w: 100, h: 40 })
  })

  it('falls back to an answer when no locate item has a bbox', () => {
    const r = parseResponse('{"mode":"locate","items":[{"label":"x"}]}')
    expect(r.mode).toBe('answer')
  })

  it('normalizes top-level open_url', () => {
    const r = parseResponse('{"mode":"action","url":"https://example.com"}')
    expect(r).toMatchObject({
      mode: 'action',
      actions: [{ type: 'open_url', url: 'https://example.com' }]
    })
  })
})
