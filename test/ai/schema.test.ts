import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseReplyText,
  replySchema,
  toModelResponse,
  PARSE_FAILED_TEXT,
  type ModeReply
} from '../../src/main/ai/schema'
import { extractJsonObject, parseJsonAs, stripNulls } from '../../src/main/ai/json'
import { anthropicJsonSchema, openaiStrictSchema } from '../../src/main/ai/providers/structured'

type Json = Record<string, unknown>

function walk(node: unknown, visit: (n: Json) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit))
  if (!node || typeof node !== 'object') return
  visit(node as Json)
  for (const v of Object.values(node as Json)) walk(v, visit)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const samples: ModeReply[] = [
  {
    mode: 'answer',
    spoken: 'It is 4.',
    markdown: '**4**',
    point: { kind: 'point', x: 1, y: 2, frame: '1' }
  },
  {
    mode: 'guide',
    steps: [
      { label: 'Click File', target: { kind: 'text', text: 'File' } },
      { label: 'Pick Save', target: { kind: 'rect', x: 1, y: 2, w: 3, h: 4, frame: '1' } }
    ]
  },
  {
    mode: 'locate',
    items: [{ label: 'Inbox', target: { kind: 'element', id: 'e4' } }],
    notFoundReason: 'scrolled away'
  },
  {
    mode: 'action',
    summary: 'Open YouTube',
    risk: 'low',
    actions: [
      { type: 'open_url', url: 'https://youtube.com' },
      { type: 'click_bbox', bbox: { x: 1, y: 2, w: 3, h: 4 }, description: 'avatar' },
      { type: 'scroll', direction: 'down', amount: 1 },
      { type: 'focus_browser' }
    ],
    followUp: 'Click Your channel'
  },
  { mode: 'text_insert', text: 'Hello', targetField: { kind: 'mark', n: 3 } },
  { mode: 'clarify', question: 'Which file?' }
]

describe('reply schema', () => {
  it('round-trips every mode through JSON', () => {
    for (const response of samples) {
      const parsed = replySchema.parse(JSON.parse(JSON.stringify({ response })))
      expect(parsed.response).toEqual(response)
    }
  })

  it('rejects bbox arrays and unknown modes', () => {
    const bad = {
      response: {
        mode: 'action',
        summary: 's',
        risk: 'low',
        actions: [{ type: 'click_bbox', bbox: [1, 2, 3, 4] }]
      }
    }
    expect(replySchema.safeParse(bad).success).toBe(false)
    expect(replySchema.safeParse({ response: { mode: 'dance' } }).success).toBe(false)
  })

  it('anthropic schema: closed objects, enforced consts, within the API limits', () => {
    const schema = anthropicJsonSchema(replySchema)
    let unions = 0
    let optional = 0
    let consts = 0
    walk(schema, (n) => {
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false)
        const req = new Set((n.required as string[]) ?? [])
        optional += Object.keys(n.properties as Json).filter((k) => !req.has(k)).length
      }
      if (n.anyOf) unions++
      if ('const' in n) consts++
      expect(n.$ref).toBeUndefined()
    })
    expect(schema.type).toBe('object')
    expect(consts).toBeGreaterThan(10)
    expect(unions).toBeLessThanOrEqual(16)
    expect(optional).toBeLessThanOrEqual(24)
  })

  it('openai schema: object root, every property required, optionals nullable', () => {
    const schema = openaiStrictSchema(replySchema)
    expect(schema.type).toBe('object')
    walk(schema, (n) => {
      if (n.type !== 'object') return
      expect(n.additionalProperties).toBe(false)
      expect(n.required).toEqual(Object.keys(n.properties as Json))
    })
    const answer = JSON.stringify(schema)
    expect(answer).toContain('{"type":"null"}')
  })

  it('a strict reply with nulls validates after stripping', () => {
    const raw = '{"response":{"mode":"answer","spoken":"Hi.","markdown":null,"point":null}}'
    expect(parseJsonAs(raw, replySchema)?.response).toEqual({ mode: 'answer', spoken: 'Hi.' })
  })
})

describe('tolerant fallback', () => {
  it('reads wrapped, bare and fenced replies', () => {
    expect(parseReplyText('{"response":{"mode":"clarify","question":"Which?"}}')).toEqual({
      mode: 'clarify',
      question: 'Which?'
    })
    expect(parseReplyText('Sure: ```json\n{"mode":"answer","spoken":"Yes."}\n```')).toEqual({
      mode: 'answer',
      spoken: 'Yes.'
    })
  })

  it('keeps plain prose and hides broken JSON', () => {
    expect(parseReplyText('Paris is the capital.')).toEqual({
      mode: 'answer',
      spoken: 'Paris is the capital.'
    })
    expect(parseReplyText('{"mode":"action","actions":[')).toEqual({
      mode: 'answer',
      spoken: PARSE_FAILED_TEXT
    })
    expect(parseReplyText('   ')).toEqual({ mode: 'answer', spoken: PARSE_FAILED_TEXT })
  })

  it('extracts the first balanced object, ignoring braces in strings', () => {
    expect(extractJsonObject('x {"a":"}"} {"b":1}')).toBe('{"a":"}"}')
    expect(extractJsonObject('{"a":"unterminated}')).toBeNull()
    expect(stripNulls({ a: null, b: [{ c: null, d: 1 }] })).toEqual({ b: [{ d: 1 }] })
  })
})

describe('toModelResponse adapter', () => {
  it('answer: card shows markdown, falls back to spoken', () => {
    expect(toModelResponse(samples[0])).toMatchObject({
      mode: 'answer',
      text: '**4**',
      spoken: 'It is 4.',
      point: { kind: 'point' }
    })
    expect(toModelResponse({ mode: 'answer', spoken: 'Hi.' })).toEqual({
      mode: 'answer',
      text: 'Hi.',
      spoken: 'Hi.'
    })
  })

  it('clarify becomes an answer card with the question', () => {
    expect(toModelResponse(samples[5])).toEqual({
      mode: 'answer',
      text: 'Which file?',
      spoken: 'Which file?',
      clarify: true
    })
  })

  it('guide: rect/point targets become bboxes, text targets become hints', () => {
    const r = toModelResponse(samples[1])
    expect(r.mode).toBe('guide')
    if (r.mode !== 'guide') return
    expect(r.steps[0]).toMatchObject({ label: 'Click File', target_hint: 'File' })
    expect(r.steps[0].bbox).toBeUndefined()
    expect(r.steps[1].bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })

  it('locate: drops items without geometry, answers with the not-found reason', () => {
    expect(toModelResponse(samples[2])).toEqual({ mode: 'answer', text: 'scrolled away' })
    const r = toModelResponse({
      mode: 'locate',
      items: [{ label: 'Bell', target: { kind: 'point', x: 100, y: 50, frame: '1' } }]
    })
    expect(r).toMatchObject({ mode: 'locate', items: [{ bbox: { x: 84, y: 34, w: 32, h: 32 } }] })
  })

  it('action: open_url reuses the tab in a browser, followUp gets a delay', () => {
    const r = toModelResponse(samples[3], 'Home - YouTube - Google Chrome')
    expect(r).toMatchObject({
      mode: 'action',
      risk: 'low',
      summary: 'Open YouTube',
      follow_up: { query: 'Click Your channel', delay_ms: 2000 }
    })
    if (r.mode === 'action')
      expect(r.actions[0]).toEqual({ type: 'navigate_url', url: 'https://youtube.com' })
    const outside = toModelResponse(samples[3], 'Explorer')
    if (outside.mode === 'action') expect(outside.actions[0].type).toBe('open_url')
  })

  it('action: drops follow-ups that are questions to the user', () => {
    const r = toModelResponse({
      mode: 'action',
      summary: 's',
      risk: 'low',
      actions: [],
      followUp: 'Do you want me to send it?'
    })
    expect(r.mode === 'action' && r.follow_up).toBeFalsy()
  })

  it('text_insert keeps the text and the field target', () => {
    expect(toModelResponse(samples[4])).toEqual({
      mode: 'text_insert',
      text: 'Hello',
      target_hint: '',
      targetField: { kind: 'mark', n: 3 }
    })
  })
})
