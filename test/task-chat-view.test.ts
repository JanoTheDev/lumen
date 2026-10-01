// Task chat view (08 T43): pure helpers and static markup checks (there is no DOM library in
// this repo; keyboard and screen reader behaviour is a hand test).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatEntry, ChatHeader, ChatView } from '@shared/task-chat'
import {
  announcement,
  applyBuffered,
  applyDelta,
  composerHint,
  duration,
  groupEntries,
  headerFacts,
  rowChanged
} from '../src/renderer/src/panel/tasks/chat-view'
import { ChatEntries } from '../src/renderer/src/panel/tasks/ChatEntries'
import { parseRoute } from '../src/renderer/src/panel/routes'

const header: ChatHeader = {
  id: 'bg_view01',
  kind: 'background',
  title: 'Check my email',
  phase: 'running',
  steps: 2,
  modelCalls: 3,
  costUsd: 0.034,
  startedAt: 0,
  canStop: true,
  canPause: true,
  canResume: false,
  canRunAgain: false,
  canSteer: true
}

const tool = (n: number, status: 'ok' | 'running' = 'ok'): ChatEntry => ({
  n,
  at: n,
  k: 'tool',
  name: 'act',
  label: `Clicked “Reply ${n}”`,
  args: 'op: click',
  status,
  result: 'ok'
})

describe('chat view helpers', () => {
  it('upserts deltas by entry number and swaps the header', () => {
    const view: ChatView = { header, entries: [tool(1, 'running')], dropped: 0 }
    const next = applyDelta(view, {
      id: 'bg_view01',
      header: { ...header, steps: 3 },
      entries: [tool(1), tool(2)]
    })!
    expect(next.entries.map((e) => e.n)).toEqual([1, 2])
    expect(next.entries[0]).toMatchObject({ status: 'ok' })
    expect(next.header.steps).toBe(3)
    expect(applyDelta(view, { id: 'bg_other1', entries: [tool(9)] })).toBe(view)
  })

  it('folds long runs of tool rows', () => {
    const items = groupEntries([
      { n: 1, at: 1, k: 'user', text: 'go' },
      tool(2),
      tool(3),
      tool(4),
      tool(5),
      { n: 6, at: 6, k: 'assistant', text: 'done' },
      tool(7)
    ])
    expect(items.map((i) => i.type)).toEqual(['entry', 'tools', 'entry', 'entry'])
  })

  it('says the facts and what is read out', () => {
    expect(headerFacts(header, 125_000)).toBe('2 steps · 3 model calls · $0.03 · 2 min 05 s')
    expect(duration(3_700_000)).toBe('1 h 1 min')
    expect(announcement(tool(1), 'T')).toBeNull()
    expect(announcement({ n: 1, at: 1, k: 'question', text: 'Which?' }, 'T')).toBe('T asks: Which?')
    expect(composerHint({ ...header, canSteer: false, phase: 'done' })).toBe('This task has ended.')
  })

  it('routes #/tasks/<id>', () => {
    expect(parseRoute('#/tasks/bg_abc123')).toEqual({ name: 'tasks', id: 'bg_abc123' })
    expect(parseRoute('#/tasks')).toEqual({ name: 'tasks' })
    expect(parseRoute('#/tasks/../x')).toEqual({ name: 'tasks' })
  })
})

describe('ChatEntries markup', () => {
  const html = renderToStaticMarkup(
    createElement(ChatEntries, {
      header: { ...header, question: { text: 'Which inbox?', choices: ['Work', 'Home'] } },
      dropped: 2,
      onChoice: () => {},
      entries: [
        { n: 1, at: 1, k: 'user', text: 'check my email' },
        { n: 2, at: 2, k: 'assistant', text: 'Looking **now**.' },
        tool(3),
        { n: 4, at: 4, k: 'question', text: 'Which inbox?', choices: ['Work', 'Home'] },
        { n: 5, at: 5, k: 'result', text: 'Three new mails.', ok: true }
      ]
    })
  )

  it('is a labelled list with collapsible tool rows', () => {
    expect(html).toMatch(/<ol class="chat-log" aria-label="Conversation with Check my email">/)
    expect(html).toContain('<details class="chat-tool">')
    expect(html).toContain('aria-label="Clicked “Reply 3” · ok"')
    expect(html).toContain('2 older entries were not kept.')
  })

  it('offers the waiting question’s answers as buttons', () => {
    expect(html).toContain('role="group" aria-label="Answers"')
    for (const m of html.matchAll(/<button\b([^>]*)>/g)) expect(m[1]).toContain('type="button"')
    expect(html).toContain('>Work<')
  })
})

describe('snapshot and early pushes', () => {
  it('applies only the pushes newer than the snapshot, so none undoes it', () => {
    const snap: ChatView = { header, entries: [tool(1, 'ok')], dropped: 0, seq: 5 }
    const older = { id: header.id, entries: [tool(1, 'running')], seq: 4 }
    const newer = { id: header.id, entries: [tool(2, 'running')], seq: 6 }
    const v = applyBuffered(snap, [older, newer])
    expect(v.entries.map((e) => (e.k === 'tool' ? `${e.n}:${e.status}` : ''))).toEqual([
      '1:ok',
      '2:running'
    ])
  })

  it('refreshes the side list only when the open chat’s row changes', () => {
    const row = {
      id: header.id,
      kind: 'background' as const,
      title: header.title,
      phase: 'running' as const,
      at: 0
    }
    expect(rowChanged([row], header)).toBe(false)
    expect(rowChanged([row], { ...header, phase: 'done' })).toBe(true)
  })
})
