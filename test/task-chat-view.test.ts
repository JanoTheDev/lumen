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
  FAST_FOLLOW_MS,
  followScroll,
  groupEntries,
  headerFacts,
  jobsLine,
  jobStepsLine,
  rowChanged,
  stepEntry
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

describe('sub-agent groups (08 T49)', () => {
  const jobsRow: ChatEntry = {
    n: 50,
    at: 50,
    k: 'tool',
    name: 'run_subagents',
    label: 'Asked 2 helpers',
    status: 'running',
    jobs: [
      {
        role: 'researcher',
        task: 'price at shop a',
        status: 'running',
        costUsd: 0.004,
        step: 'Read a.example'
      },
      {
        role: 'checker',
        task: 'check b',
        status: 'done',
        costUsd: 0.003,
        result: 'Confirmed: 10 EUR'
      }
    ]
  }

  it('a run_subagents row never folds into a steps group', () => {
    const items = groupEntries([tool(1), tool(2), jobsRow, tool(3), tool(4)], 2)
    expect(items.map((i) => (i.type === 'tools' ? `g${i.entries.length}` : i.entry.n))).toEqual([
      'g2',
      50,
      'g2'
    ])
  })

  it('summarises the jobs and renders one row per job', () => {
    expect(jobsLine(jobsRow.k === 'tool' ? (jobsRow.jobs ?? []) : [])).toBe(
      '2 helpers · 1 working · 1 done · $0.01'
    )
    const html = renderToStaticMarkup(
      createElement(ChatEntries, { entries: [jobsRow], header, dropped: 0, onChoice: () => {} })
    )
    expect(html).toContain('chat-jobs')
    expect(html).toContain('price at shop a')
    expect(html).toContain('Confirmed: 10 EUR')
    expect(html).toContain('Read a.example')
    expect(html.match(/chat-job"/g)?.length).toBe(2)
  })
})

describe('sub-agent job steps', () => {
  const steps = [
    {
      n: 5,
      label: 'Read a.example/lamp',
      args: 'url: https://a.example/lamp',
      status: 'ok' as const,
      result: 'Price: 10'
    },
    { n: 6, label: 'Searched memory', status: 'error' as const, result: 'It failed' }
  ]
  const job = {
    role: 'researcher',
    task: 'price at shop a',
    status: 'done' as const,
    costUsd: 0,
    steps,
    stepsDropped: 3
  }

  it('summarises the steps of a job', () => {
    expect(jobStepsLine(job)).toBe('5 steps · 1 failed · 3 earlier not kept')
    expect(jobStepsLine({ ...job, steps: [steps[0]], stepsDropped: undefined })).toBe('1 step')
    expect(jobStepsLine({ ...job, steps: undefined, stepsDropped: undefined })).toBeNull()
  })

  it('turns a step into a tool row', () => {
    expect(stepEntry(steps[0])).toEqual({
      k: 'tool',
      n: 5,
      at: 0,
      name: '',
      label: 'Read a.example/lamp',
      status: 'ok',
      args: 'url: https://a.example/lamp',
      result: 'Price: 10'
    })
  })

  it('renders the steps under the job row', () => {
    const row: ChatEntry = {
      n: 60,
      at: 60,
      k: 'tool',
      name: 'run_subagents',
      label: 'Asked 1 helper',
      status: 'ok',
      jobs: [job]
    }
    const html = renderToStaticMarkup(
      createElement(ChatEntries, { entries: [row], header, dropped: 0, onChoice: () => {} })
    )
    expect(html).toContain('chat-job__steps')
    expect(html).toContain('5 steps · 1 failed · 3 earlier not kept')
    expect(html).toContain('Read a.example/lamp')
    expect(html).toContain('Price: 10')
    expect(html).toContain('Searched memory')
  })
})

describe('delta apply and follow scrolling', () => {
  const view = (ns: number[]): ChatView => ({
    header,
    entries: ns.map((n) => tool(n)),
    dropped: 0
  })
  const ns = (v: ChatView | null): number[] => v?.entries.map((e) => e.n) ?? []

  it('updates in place, appends and slots an older entry into its place', () => {
    const v = view([1, 3, 5])
    const inPlace = applyDelta(v, { id: header.id, entries: [tool(3, 'running')] })!
    expect(ns(inPlace)).toEqual([1, 3, 5])
    expect(inPlace.entries[1]).toMatchObject({ status: 'running' })
    expect(inPlace.entries[0]).toBe(v.entries[0])
    expect(v.entries[1]).toMatchObject({ status: 'ok' })
    expect(ns(applyDelta(v, { id: header.id, entries: [tool(7)] }))).toEqual([1, 3, 5, 7])
    expect(ns(applyDelta(v, { id: header.id, entries: [tool(4), tool(0), tool(2)] }))).toEqual([
      0, 1, 2, 3, 4, 5
    ])
    const first = applyDelta(v, { id: header.id, entries: [tool(1, 'running')] })!
    expect(ns(first)).toEqual([1, 3, 5])
    expect(first.entries[0]).toMatchObject({ status: 'running' })
  })

  it('applies 400 deltas onto 400 entries quickly', () => {
    let v: ChatView | null = view(Array.from({ length: 400 }, (_, i) => i))
    const t = performance.now()
    for (let i = 0; i < 400; i++)
      v = applyDelta(v, { id: header.id, entries: [tool(399 - (i % 400), 'running')] })
    v = applyDelta(v, { id: header.id, entries: Array.from({ length: 400 }, (_, i) => tool(i)) })
    expect(performance.now() - t).toBeLessThan(200)
    expect(ns(v)).toEqual(Array.from({ length: 400 }, (_, i) => i))
  })

  it('follows only a new or changed newest row, without animation when rapid', () => {
    const entries = [tool(1), tool(2)]
    const mark = { count: 2, last: entries[1], at: 1000 }
    const later = 1000 + FAST_FOLLOW_MS + 1
    expect(followScroll(mark, [tool(1, 'running'), entries[1]], later, false)).toBeNull()
    expect(followScroll(mark, [...entries, tool(3)], later, false)).toBe('smooth')
    expect(followScroll(mark, [entries[0], tool(2, 'running')], later, false)).toBe('smooth')
    expect(followScroll(mark, [...entries, tool(3)], 1100, false)).toBe('auto')
    expect(followScroll(mark, [...entries, tool(3)], later, true)).toBe('auto')
    expect(followScroll({ count: 0, last: undefined, at: 0 }, entries, later, false)).toBe('smooth')
  })
})
