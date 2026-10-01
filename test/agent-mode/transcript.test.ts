import { describe, expect, it } from 'vitest'
import type { ChatEntry } from '@shared/task-chat'
import {
  argsSummary,
  MAX_CHARS,
  MAX_ENTRIES,
  RESULT_MAX,
  resultSummary,
  steerTurn,
  toolLabel,
  TranscriptRecorder
} from '../../src/main/agent-mode/transcript'
import { withSteer } from '../../src/main/agent-mode/runner'

// Built at runtime: a key-shaped literal in the repo trips secret scanning.
const KEY = ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUv'].join('-')

function recorder(): { r: TranscriptRecorder; pushed: ChatEntry[] } {
  const pushed: ChatEntry[] = []
  let t = 0
  const r = new TranscriptRecorder('bg_test01', { now: () => ++t, onEntry: (e) => pushed.push(e) })
  return { r, pushed }
}

describe('TranscriptRecorder', () => {
  it('redacts secrets in every text it keeps', () => {
    const { r } = recorder()
    r.user(`use the key ${KEY} please`)
    r.assistant(`I found ${KEY} on the page`)
    r.toolStart({ id: 'c1', name: 'fetch_url', input: { url: `https://x.com/?k=${KEY}` } })
    r.toolEnd(
      { id: 'c1', name: 'fetch_url', input: {} },
      { content: [{ type: 'text', text: `<observed>token ${KEY}</observed>` }] }
    )
    const json = JSON.stringify(r.data())
    expect(json).not.toContain(KEY)
    expect(json).toContain('[redacted:api-key]')
  })

  it('keeps typed text only as its length', () => {
    const { r } = recorder()
    r.toolStart({
      id: 'c1',
      name: 'act',
      input: { op: 'type', value: 'hunter2 secret words', target: { kind: 'element', ref: 'Body' } }
    })
    const e = r.entries[0]
    expect(e).toMatchObject({ k: 'tool', label: 'Typed 20 characters into “Body”' })
    expect(JSON.stringify(r.data())).not.toContain('hunter2')
  })

  it('updates a tool row in place with its outcome and pushes both versions', () => {
    const { r, pushed } = recorder()
    const call = {
      id: 'c1',
      name: 'act',
      input: { op: 'click', target: { kind: 'text', ref: 'Reply' } }
    }
    r.toolStart(call)
    r.toolEnd(call, { content: [{ type: 'text', text: 'E_DENIED: not allowed' }], isError: true })
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ label: 'Clicked “Reply”', status: 'denied' })
    expect(pushed.map((e) => e.n)).toEqual([1, 1])
    expect(pushed[0]).toMatchObject({ status: 'running' })
  })

  it('cuts results short and drops screenshots', () => {
    const long = 'x'.repeat(5000)
    expect(resultSummary([{ type: 'text', text: long }]).length).toBeLessThanOrEqual(RESULT_MAX)
    expect(resultSummary([{ type: 'image', base64: 'AAAA' }])).toBe('[screenshot]')
  })

  it('caps entries and size, keeping the task prompt first', () => {
    const { r } = recorder()
    r.user('the original request')
    for (let i = 0; i < MAX_ENTRIES + 50; i++) r.status(`line ${i}`)
    expect(r.entries.length).toBeLessThanOrEqual(MAX_ENTRIES)
    expect(r.entries[0]).toMatchObject({ k: 'user', text: 'the original request' })
    expect(r.dropped).toBeGreaterThan(0)
    const { r: big } = recorder()
    big.user('first')
    for (let i = 0; i < 200; i++) big.assistant(`${i} ${'y'.repeat(3000)}`)
    const chars = big.entries.reduce((s, e) => s + JSON.stringify(e).length, 0)
    expect(chars).toBeLessThan(MAX_CHARS * 1.2)
    expect(big.entries[0]).toMatchObject({ text: 'first' })
  })

  it('turns ask_user into a question and keeps the same question once', () => {
    const { r } = recorder()
    const ask = {
      id: 'q1',
      name: 'ask_user',
      input: { question: 'Which inbox?', choices: ['Work', 'Home'] }
    }
    r.toolStart(ask)
    r.question('Which inbox?', ['Work', 'Home'])
    expect(r.entries).toHaveLength(1)
    r.answer('Work')
    r.toolEnd(ask, { content: [{ type: 'text', text: 'The user said: Work' }] })
    expect(r.entries[0]).toMatchObject({ k: 'question', answer: 'Work', choices: ['Work', 'Home'] })
  })

  it('an answer without an open question is a user line; closeOpen ends running rows', () => {
    const { r } = recorder()
    r.answer('hello')
    r.toolStart({ id: 'c1', name: 'observe', input: { what: 'screen' } })
    r.closeOpen()
    expect(r.entries.map((e) => e.k)).toEqual(['user', 'tool'])
    expect(r.entries[1]).toMatchObject({ status: 'error', result: 'Stopped.' })
  })

  it('reloads from saved data and keeps numbering', () => {
    const { r } = recorder()
    r.user('a')
    r.assistant('b')
    const again = new TranscriptRecorder('bg_test01', { now: () => 9 }, r.data())
    again.status('c')
    expect(again.entries.map((e) => e.n)).toEqual([1, 2, 3])
  })
})

describe('tool labels', () => {
  it('reads like what happened', () => {
    expect(toolLabel('keys', { combo: 'ctrl+s' })).toBe('Pressed ctrl+s')
    expect(toolLabel('navigate', { url: 'https://mail.example.com/inbox?x=1' })).toBe(
      'Opened mail.example.com/inbox'
    )
    expect(toolLabel('fetch_url', { url: 'not a url' })).toBe('Read not a url')
    expect(toolLabel('read_file', { path: 'C:\\Users\\me\\notes.txt' })).toBe('Read notes.txt')
    expect(toolLabel('mcp__github__list_issues', {})).toBe('Used list issues (github)')
    expect(toolLabel('observe', { what: 'screen' })).toBe('Looked at the screen')
    expect(argsSummary('keys', { combo: 'enter', step: 2 })).toBe('combo: enter')
  })
})

describe('steer messages', () => {
  it('join the last user turn as the user’s own words', () => {
    const msgs = withSteer(
      [
        { role: 'user', content: [{ type: 'text', text: 'task' }] },
        { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'observe', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', id: 'c1', content: [] }] }
      ],
      ['also check Outlook']
    )
    expect(msgs).toHaveLength(3)
    const last = msgs[2]
    expect(last.role).toBe('user')
    if (last.role !== 'user') return
    expect(last.content[0]).toMatchObject({ type: 'tool_result' })
    expect(last.content[1]).toMatchObject({ type: 'text', text: steerTurn(['also check Outlook']) })
    expect(steerTurn(['a', 'b'])).toContain('- a\n- b')
  })
})
