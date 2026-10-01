import { describe, expect, it } from 'vitest'
import {
  ConversationHistory,
  historyExchange,
  MAX_STORED_EXCHANGES
} from '../../src/main/ai/history'
import { matchMemoryCommand } from '../../src/main/query/memory-commands'
import { prefilter } from '../../src/main/query/router'

const make = (historyExchanges = 5, historyEnabled = true): ConversationHistory => {
  const s = { historyEnabled, historyExchanges }
  return new ConversationHistory(() => s)
}

describe('ConversationHistory', () => {
  it('keeps utterance, spoken reply, mode and target labels', () => {
    const h = make()
    h.add({
      utterance: 'where is compose',
      spoken: 'highlighted',
      mode: 'locate',
      targets: ['Compose']
    })
    expect(h.messages()).toEqual([
      { role: 'user', content: 'where is compose' },
      { role: 'assistant', content: '[locate] highlighted (pointed at: Compose)' }
    ])
  })

  it('sends only the last historyExchanges exchanges and caps storage', () => {
    const h = make(2)
    for (let i = 0; i < MAX_STORED_EXCHANGES + 10; i++)
      h.add({ utterance: `q${i}`, spoken: `a${i}` })
    expect(h.size).toBe(MAX_STORED_EXCHANGES)
    expect(h.messages().map((m) => m.content)).toEqual(['q58', 'a58', 'q59', 'a59'])
  })

  it('stores nothing when disabled and sends nothing with 0 exchanges', () => {
    const off = make(5, false)
    off.add({ utterance: 'q', spoken: 'a' })
    expect(off.size).toBe(0)
    const zero = make(0)
    zero.add({ utterance: 'q', spoken: 'a' })
    expect(zero.messages()).toEqual([])
  })

  it('clear and dropLast', () => {
    const h = make()
    h.add({ utterance: 'a', spoken: '1' })
    h.add({ utterance: 'b', spoken: '2' })
    expect(h.dropLast()?.utterance).toBe('b')
    h.clear()
    expect(h.messages()).toEqual([])
    expect(h.dropLast()).toBeUndefined()
  })
})

describe('historyExchange', () => {
  it('records no screenshots, only text and labels', () => {
    const e = historyExchange('open settings', {
      mode: 'action',
      summary: 'Opened Settings',
      actions: [
        {
          type: 'click_target',
          target: { kind: 'text', text: 'Settings' },
          description: 'Settings'
        },
        { type: 'hotkey', keys: ['ctrl', 's'] }
      ]
    })
    expect(e).toEqual({
      utterance: 'open settings',
      mode: 'action',
      spoken: 'Opened Settings',
      targets: ['Settings']
    })
    expect(
      historyExchange('steps', {
        mode: 'guide',
        steps: [{ label: 'File', target_hint: 'File' }]
      }).targets
    ).toEqual(['File'])
    expect(historyExchange('q', { mode: 'answer', text: '**md**', spoken: 'md' }).spoken).toBe('md')
  })
})

describe('conversation commands', () => {
  const state = { guideActive: false, hasLastGuide: false, hasLastTask: false }

  it('"new topic" and "forget that" are whole-utterance prefilter hits', () => {
    expect(prefilter('New topic.', state)).toEqual({
      kind: 'memory',
      command: { kind: 'new-topic' }
    })
    expect(prefilter('ok forget that', state)).toEqual({
      kind: 'memory',
      command: { kind: 'forget-last' }
    })
    expect(matchMemoryCommand('a new topic for my essay')).toBeNull()
    expect(matchMemoryCommand('forget that email draft and write a new one')).toBeNull()
  })

  it('"forget it" stays a cancel word', () => {
    expect(prefilter('forget it', state)).toEqual({ kind: 'cancel' })
  })
})
