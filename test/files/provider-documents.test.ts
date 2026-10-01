// Shared PDFs (08 T21) in both providers: Anthropic `document` blocks, OpenAI `input_file`.
import { describe, expect, it } from 'vitest'
import {
  buildParams as anthropicParams,
  buildToolParams as anthropicToolParams
} from '../../src/main/ai/providers/anthropic'
import {
  buildParams as openaiParams,
  buildToolParams as openaiToolParams
} from '../../src/main/ai/providers/openai'
import type { ChatRequest, ToolTurnRequest } from '../../src/main/ai/providers/types'

const doc = { name: 'r.pdf', base64: 'JVBERi0=', mediaType: 'application/pdf' as const }

const chat: ChatRequest = {
  model: 'm',
  system: [],
  messages: [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'summarize this' }
  ],
  images: [{ base64: 'IMG', mediaType: 'image/png' }],
  documents: [doc],
  maxTokens: 100
}

const turn: ToolTurnRequest = {
  model: 'm',
  system: [],
  tools: [],
  maxTokens: 100,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'task' }] },
    {
      role: 'assistant',
      text: '',
      calls: [{ id: 'c1', name: 'read_file', input: { fileId: 'f_1' } }]
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: 'c1',
          content: [
            { type: 'text', text: 'attached' },
            { type: 'document', ...doc }
          ]
        }
      ]
    }
  ]
}

describe('anthropic', () => {
  it('sends PDFs as base64 document blocks after images, before the text', () => {
    const p = anthropicParams(chat)
    expect(p.messages[0].content).toBe('earlier')
    expect(p.messages[2].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMG' } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        title: 'r.pdf'
      },
      { type: 'text', text: 'summarize this' }
    ])
  })

  it('a document alone still makes a block list', () => {
    const p = anthropicParams({ ...chat, images: [] })
    expect((p.messages[2].content as { type: string }[]).map((b) => b.type)).toEqual([
      'document',
      'text'
    ])
  })

  it('puts a document inside a tool_result', () => {
    const p = anthropicToolParams(turn)
    const result = (p.messages[2].content as { type: string; content: { type: string }[] }[])[0]
    expect(result.type).toBe('tool_result')
    expect(result.content.map((c) => c.type)).toEqual(['text', 'document'])
  })
})

describe('openai', () => {
  it('sends PDFs as input_file data URLs', () => {
    const p = openaiParams(chat)
    const input = p.input as { role: string; content: unknown }[]
    expect(input[2].content).toEqual([
      { type: 'input_image', image_url: 'data:image/png;base64,IMG', detail: 'high' },
      { type: 'input_file', filename: 'r.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
      { type: 'input_text', text: 'summarize this' }
    ])
  })

  it('puts a file in function_call_output', () => {
    const p = openaiToolParams(turn)
    const out = (p.input as { type?: string; output?: unknown }[]).find(
      (i) => i.type === 'function_call_output'
    )
    expect(out?.output).toEqual([
      { type: 'input_text', text: 'attached' },
      { type: 'input_file', filename: 'r.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }
    ])
  })
})
