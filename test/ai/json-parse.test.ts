// Edge cases for the tolerant reply parser (local models and other providers without
// structured output). The schema round-trips and the adapter live in schema.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractJsonObject, readPartialString } from '../../src/main/ai/json'
import { PARSE_FAILED_TEXT, parseReplyText } from '../../src/main/ai/schema'

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('extractJsonObject', () => {
  it.each([
    ['escaped quote before a brace', '{"a":"say \\"}\\" now"} tail', '{"a":"say \\"}\\" now"}'],
    ['escaped backslash ends the string', '{"a":"C:\\\\"} {"b":1}', '{"a":"C:\\\\"}'],
    ['nested objects', 'x {"a":{"b":{"c":1}},"d":2} y', '{"a":{"b":{"c":1}},"d":2}'],
    ['brace in leading prose is the start', 'Use {curly} braces', '{curly}'],
    ['opening brace inside a string', '{"a":"{{{"}', '{"a":"{{{"}']
  ])('%s', (_name, input, expected) => {
    expect(extractJsonObject(input)).toBe(expected)
  })

  it.each([
    ['no object', 'plain prose'],
    ['cut mid-object (max_tokens)', '{"response":{"mode":"answer","spoken":"Hel'],
    ['cut after a nested close', '{"a":{"b":1}'],
    ['only a close brace', '} nothing here']
  ])('%s → null', (_name, input) => {
    expect(extractJsonObject(input)).toBeNull()
  })
})

describe('parseReplyText edge cases', () => {
  const answer = (spoken: string): { mode: 'answer'; spoken: string } => ({
    mode: 'answer',
    spoken
  })

  it('reads JSON after a sentence of prose', () => {
    expect(
      parseReplyText('Here you go: {"response":{"mode":"answer","spoken":"Done."}} Thanks!')
    ).toEqual(answer('Done.'))
  })

  it('reads a fenced block without a language tag', () => {
    expect(parseReplyText('```\n{"mode":"clarify","question":"Which one?"}\n```')).toEqual({
      mode: 'clarify',
      question: 'Which one?'
    })
  })

  it('keeps braces and quotes inside the spoken text', () => {
    const spoken = 'Type {name} then "}" and press Enter.'
    const raw = JSON.stringify({ response: { mode: 'answer', spoken } })
    expect(parseReplyText(`prefix ${raw}`)).toEqual(answer(spoken))
  })

  it('a reply truncated by max_tokens shows the fallback, never half a JSON', () => {
    const full = JSON.stringify({
      response: { mode: 'guide', steps: [{ label: 'Open the File menu' }, { label: 'Save' }] }
    })
    for (const cut of [1, 10, full.length / 2, full.length - 1]) {
      const r = parseReplyText(full.slice(0, Math.floor(cut)))
      expect(r).toEqual(answer(PARSE_FAILED_TEXT))
    }
  })

  it('valid JSON in the wrong shape falls back instead of throwing', () => {
    expect(parseReplyText('{"response":{"mode":"answer"}}')).toEqual(answer(PARSE_FAILED_TEXT))
    expect(parseReplyText('{"foo":1}')).toEqual(answer(PARSE_FAILED_TEXT))
  })

  it('prose that mentions braces is not shown as an answer', () => {
    expect(parseReplyText('Use {curly} braces')).toEqual(answer(PARSE_FAILED_TEXT))
  })

  it('every mode survives a prose prefix and suffix', () => {
    const replies = [
      { mode: 'answer', spoken: 'Yes.' },
      { mode: 'guide', steps: [{ label: 'Click File', target: { kind: 'text', text: 'File' } }] },
      { mode: 'locate', items: [{ label: 'Inbox', target: { kind: 'element', id: 'e4' } }] },
      {
        mode: 'action',
        summary: 'Scroll',
        risk: 'low',
        actions: [{ type: 'scroll', direction: 'down' }]
      },
      { mode: 'text_insert', text: 'Hello' },
      { mode: 'clarify', question: 'Which?' }
    ]
    for (const response of replies) {
      const text = `Sure. ${JSON.stringify({ response })}\nLet me know.`
      expect(parseReplyText(text)).toEqual(response)
    }
  })
})

describe('readPartialString (streamed spoken text)', () => {
  it('decodes escapes and stops at an escape cut in half', () => {
    expect(readPartialString('{"spoken":"a\\nb', 'spoken')).toEqual({ text: 'a\nb', done: false })
    expect(readPartialString('{"spoken":"a\\', 'spoken')).toEqual({ text: 'a', done: false })
    expect(readPartialString('{"spoken":"\\u00e9', 'spoken')).toEqual({ text: 'é', done: false })
    expect(readPartialString('{"spoken":"\\u00', 'spoken')).toEqual({ text: '', done: false })
    expect(readPartialString('{"spoken":"Hi."}', 'spoken')).toEqual({ text: 'Hi.', done: true })
    expect(readPartialString('{"mode":"answer"', 'spoken')).toBeNull()
  })
})
