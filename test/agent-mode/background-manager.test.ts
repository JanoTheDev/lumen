import { describe, expect, it } from 'vitest'
import type { BackgroundTask } from '@shared/types'
import {
  BackgroundManager,
  KEEP_TASKS,
  taskTitle,
  type ManagerDeps,
  type RunOutcome,
  type TaskControl
} from '../../src/main/agent-mode/background/manager'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface Run {
  ctl: TaskControl
  finish(r?: Partial<RunOutcome>): void
  fail(e: Error): void
}

interface Setup {
  m: BackgroundManager
  runs: Run[]
  emitted: BackgroundTask[]
  saved: Map<string, BackgroundTask>
  finished: BackgroundTask[]
}

function setup(max = 3, over: Partial<ManagerDeps> = {}): Setup {
  const runs: Run[] = []
  const emitted: BackgroundTask[] = []
  const saved = new Map<string, BackgroundTask>()
  const finished: BackgroundTask[] = []
  let n = 0
  let now = 1000
  const m = new BackgroundManager({
    max: () => max,
    run: (ctl) =>
      new Promise<RunOutcome>((resolve, reject) => {
        runs.push({
          ctl,
          finish: (r = {}) => resolve({ status: 'done', summary: 'ok', ...r }),
          fail: reject
        })
        ctl.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    emit: (t) => emitted.push(t),
    save: (t) => saved.set(t.id, t),
    remove: (id) => saved.delete(id),
    finished: (t) => finished.push(t),
    now: () => now++,
    newId: () => `bg_test${(n++).toString().padStart(2, '0')}`,
    ...over
  })
  return { m, runs, emitted, saved, finished }
}

describe('BackgroundManager', () => {
  it('runs at most N at once and queues the rest FIFO', async () => {
    const { m, runs } = setup(2)
    const a = m.start({ prompt: 'one thing to do', origin: 'voice' })
    const b = m.start({ prompt: 'two things to do', origin: 'voice' })
    const c = m.start({ prompt: 'three things to do', origin: 'voice' })
    const d = m.start({ prompt: 'four things to do', origin: 'voice' })
    expect([a, b, c, d].map((t) => m.get(t.id)!.phase)).toEqual([
      'running',
      'running',
      'queued',
      'queued'
    ])
    runs[0].finish()
    await tick()
    expect(m.get(a.id)!.phase).toBe('done')
    expect(m.get(c.id)!.phase).toBe('running')
    expect(m.get(d.id)!.phase).toBe('queued')
    expect(runs).toHaveLength(3)
  })

  it('done tasks keep their result, count as unseen and report finished', async () => {
    const { m, runs, finished } = setup()
    const t = m.start({ prompt: 'compare three laptops', origin: 'voice' })
    runs[0].finish({ summary: 'The X1 is cheapest.', report: '- X1 $900 (https://a.example)' })
    await m.wait(t.id)
    const done = m.get(t.id)!
    expect(done.result).toEqual({
      summary: 'The X1 is cheapest.',
      report: '- X1 $900 (https://a.example)'
    })
    expect(done.unseen).toBe(true)
    expect(m.unseenCount()).toBe(1)
    await tick()
    expect(finished.map((f) => f.id)).toEqual([t.id])
    m.markSeen()
    expect(m.unseenCount()).toBe(0)
  })

  it('a thrown run is failed with the reason', async () => {
    const { m, runs } = setup()
    const t = m.start({ prompt: 'do the thing', origin: 'voice' })
    runs[0].fail(new Error('no key'))
    const end = await m.wait(t.id)
    expect(end.phase).toBe('failed')
    expect(end.result?.summary).toContain('no key')
  })

  it('cancel aborts a running task, removes a queued one and cascades to children', async () => {
    const { m, runs } = setup(1)
    const a = m.start({ prompt: 'parent task here', origin: 'voice' })
    const child = m.start({
      prompt: 'child task here',
      origin: 'agent',
      parentId: a.id,
      immediate: true
    })
    const q = m.start({ prompt: 'queued task here', origin: 'voice' })
    expect(m.get(child.id)!.phase).toBe('running')
    expect(m.cancel(q.id)).toBe(true)
    expect(m.get(q.id)!.phase).toBe('cancelled')
    m.cancel(a.id)
    await tick()
    expect(m.get(a.id)!.phase).toBe('cancelled')
    expect(m.get(child.id)!.phase).toBe('cancelled')
    expect(runs).toHaveLength(2)
    expect(m.cancel(a.id)).toBe(false)
  })

  it('immediate children skip the queue (a waiting parent cannot deadlock the slots)', () => {
    const { m } = setup(1)
    const p = m.start({ prompt: 'parent task here', origin: 'voice' })
    const c = m.start({
      prompt: 'child task here',
      origin: 'agent',
      parentId: p.id,
      immediate: true
    })
    expect(m.get(c.id)!.phase).toBe('running')
    expect(m.childCount(p.id)).toBe(1)
  })

  it('a queued question waits for the answer from the list', async () => {
    const { m, runs } = setup()
    const t = m.start({ prompt: 'book a table', origin: 'voice' })
    const answered = runs[0].ctl.ask('Which day?', ['Friday', 'Saturday'])
    expect(m.get(t.id)).toMatchObject({
      phase: 'asking',
      question: { text: 'Which day?', choices: ['Friday', 'Saturday'] }
    })
    expect(m.answer(t.id, '  ')).toBe(false)
    expect(m.answer(t.id, 'Friday')).toBe(true)
    await expect(answered).resolves.toBe('Friday')
    expect(m.get(t.id)!.phase).toBe('running')
    expect(m.get(t.id)!.question).toBeUndefined()
    expect(m.answer(t.id, 'again')).toBe(false)
  })

  it('questions asked at once wait in line; a withdrawn one leaves it (review H1)', async () => {
    const { m, runs } = setup()
    const t = m.start({ prompt: 'two helpers', origin: 'voice' })
    const ctl = runs[0].ctl
    const first = ctl.ask('Allow A?', ['Allow', 'Deny'])
    const gone = new AbortController()
    const withdrawn = ctl.ask('Allow B?', ['Allow', 'Deny'], 'asking', gone.signal)
    const second = ctl.ask('Allow C?', ['Allow', 'Deny'])
    expect(m.get(t.id)!.question?.text).toBe('Allow A?')
    expect(m.answer(t.id, 'Allow')).toBe(true)
    await expect(first).resolves.toBe('Allow')
    expect(m.get(t.id)!.question?.text).toBe('Allow B?')
    gone.abort(new Error('job time limit'))
    await expect(withdrawn).rejects.toThrow('job time limit')
    expect(m.get(t.id)).toMatchObject({ phase: 'asking', question: { text: 'Allow C?' } })
    expect(m.answer(t.id, 'Deny')).toBe(true)
    await expect(second).resolves.toBe('Deny')
    expect(m.get(t.id)!.phase).toBe('running')
    expect(m.get(t.id)!.question).toBeUndefined()
  })

  it('progress lines are capped, trimmed and not repeated', () => {
    const { m, runs } = setup()
    const t = m.start({ prompt: 'watch a page', origin: 'voice' })
    for (let i = 0; i < 30; i++) runs[0].ctl.progress(`line ${i}`)
    runs[0].ctl.progress('line 29')
    const p = m.get(t.id)!.progress
    expect(p).toHaveLength(20)
    expect(p.at(-1)).toBe('line 29')
  })

  it('interruptAll marks open tasks interrupted; restore turns open ones interrupted', async () => {
    const { m, saved } = setup(1)
    const a = m.start({ prompt: 'first task here', origin: 'voice' })
    const b = m.start({ prompt: 'second task here', origin: 'voice' })
    m.interruptAll()
    await tick()
    expect(m.get(a.id)!.phase).toBe('interrupted')
    expect(m.get(b.id)!.phase).toBe('interrupted')
    expect(saved.get(a.id)!.phase).toBe('interrupted')

    const fresh = setup()
    fresh.m.restore([{ ...saved.get(a.id)!, phase: 'running' }, saved.get(b.id)!])
    expect(fresh.m.get(a.id)!.phase).toBe('interrupted')
    expect(fresh.runs).toHaveLength(0)
  })

  it('run again starts the same request as a new task', () => {
    const { m } = setup()
    const a = m.start({ prompt: 'check the news', origin: 'voice', skill: 'news' })
    expect(m.runAgain(a.id)).toBeNull()
    m.interruptAll()
    const again = m.runAgain(a.id)!
    expect(again.id).not.toBe(a.id)
    expect(again).toMatchObject({ prompt: 'check the news', skill: 'news', phase: 'running' })
  })

  it('keeps only the newest finished tasks', async () => {
    const { m, saved } = setup(3)
    const ids: string[] = []
    for (let i = 0; i < KEEP_TASKS + 5; i++) {
      const t = m.start({ prompt: `task number ${i}`, origin: 'voice' })
      ids.push(t.id)
      m.cancel(t.id)
    }
    await tick()
    expect(m.list()).toHaveLength(KEEP_TASKS)
    expect(saved.has(ids[0])).toBe(false)
    expect(saved.has(ids.at(-1)!)).toBe(true)
  })
})

describe('taskTitle', () => {
  it('capitalizes and trims long prompts at a word', () => {
    expect(taskTitle('check the price.')).toBe('Check the price')
    const long = taskTitle('a '.repeat(50) + 'end')
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith('…')).toBe(true)
  })

  it('runs a task with its own runner, outside the slots, and never runs it again', async () => {
    const { m, runs } = setup(1)
    const busy = m.start({ prompt: 'fill the slot', origin: 'voice' })
    let ctl: TaskControl | null = null
    let finish: (r: RunOutcome) => void = () => {}
    const own = m.start({
      prompt: 'claude session',
      origin: 'voice',
      claude: { id: 'cc_abcd', projectName: 'proj', phase: 'thinking' },
      run: (c) =>
        new Promise<RunOutcome>((resolve) => {
          ctl = c
          finish = resolve
        })
    })
    expect(m.get(own.id)!.phase).toBe('running')
    expect(m.get(own.id)!.claude?.id).toBe('cc_abcd')
    expect(runs).toHaveLength(1)
    // The own-runner task does not hold a slot: a queued task starts when the slot frees.
    const queued = m.start({ prompt: 'waits for the slot', origin: 'voice' })
    expect(m.get(queued.id)!.phase).toBe('queued')
    runs[0].finish()
    await tick()
    expect(m.get(busy.id)!.phase).toBe('done')
    expect(m.get(queued.id)!.phase).toBe('running')
    ctl!.progress('Running npm test')
    finish({ status: 'done', summary: 'All green' })
    await tick()
    expect(m.get(own.id)!.phase).toBe('done')
    expect(m.get(own.id)!.result?.summary).toBe('All green')
    expect(m.runAgain(own.id)).toBeNull()
    expect(runs).toHaveLength(2)
  })
})
