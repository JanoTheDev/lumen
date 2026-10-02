// A buddy on screen (08 T52 gaps): the foreground run takes the buddy's model, per-run budget,
// notebook, helpers and skills and gates as the buddy; its start and end go into a run record
// that the buddy's history and list rows merge with its background runs.
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { Buddy } from '@shared/buddies'
import type { BackgroundTask, ModelResponse } from '@shared/types'
import type { RunResult } from '../../src/main/agent-mode/runner'
import type { SkillEnvelope } from '../../src/main/agent-mode/skill-envelope'
import { clampBuddy } from '../../src/main/buddies/clamp'
import { runBuddyForeground, type ForegroundDeps } from '../../src/main/buddies/foreground'
import { ScreenRuns } from '../../src/main/buddies/screen-runs'
import { Buddies } from '../../src/main/buddies/service'
import type { BuddyStore } from '../../src/main/buddies/store'

const make = (extra: Record<string, unknown> = {}): Buddy =>
  clampBuddy(
    'mail-buddy',
    {
      name: 'Mail Buddy',
      instructions: 'Sort my mail.',
      trust: 'mine',
      permissions: { input: true, screen: true },
      model: 'fast',
      budget: { perRunUsd: 0.1 },
      skills: ['tidy-inbox'],
      subagents: true,
      ...extra
    },
    { now: 1 }
  )

const result = (status: RunResult['status'], id: string, costUsd = 0.04): RunResult =>
  ({ status, summary: 'Sorted 4 mails.', task: { id, counters: { costUsd } } }) as RunResult

function deps(over: Partial<ForegroundDeps> = {}): ForegroundDeps & {
  started: unknown[]
  ended: unknown[]
} {
  const started: unknown[] = []
  const ended: unknown[] = []
  return {
    started,
    ended,
    runTask: async () => ({ mode: 'answer', text: 'ok' }) as ModelResponse,
    envelope: () => ({}) as SkillEnvelope,
    notebook: () => '',
    memoryWrite: () => 'ok',
    runs: {
      start: (...a) => started.push(a),
      end: (...a) => ended.push(a)
    },
    working: () => {},
    now: () => 50,
    ...over
  }
}

describe('runBuddyForeground settings', () => {
  it('takes the buddy model, per-run budget, notebook, helpers and skills, gated as the buddy', async () => {
    const notes: [string, string][] = []
    let seen: Parameters<ForegroundDeps['runTask']>[2] | null = null
    const d = deps({
      memoryWrite: (id, fact) => (notes.push([id, fact]), 'ok'),
      runTask: async (_p, _s, o) => {
        seen = o
        return { mode: 'answer', text: 'ok' }
      }
    })
    await runBuddyForeground(make(), { trigger: 'call' }, new AbortController().signal, d)
    const u = seen!.underEnvelope
    expect(u.role).toBe('fast')
    expect(u.caps).toEqual({ maxCostUsd: 0.1 })
    expect(u.subagents).toBe(true)
    expect(u.gate).toEqual({ origin: 'buddy', buddyId: 'mail-buddy' })
    expect(u.allowSkill?.('tidy-inbox')).toBe(true)
    expect(u.allowSkill?.('send-invoices')).toBe(false)
    expect(u.memoryWrite?.('Boss is Ann.')).toBe('ok')
    expect(notes).toEqual([['mail-buddy', 'Boss is Ann.']])
  })

  it('records the run from start to end with its cost', async () => {
    const d = deps({
      runTask: async (_p, _s, o) => {
        o.underEnvelope.onStart?.('t_9')
        o.underEnvelope.onEnd?.(result('done', 't_9'))
        return { mode: 'answer', text: 'ok' }
      }
    })
    await runBuddyForeground(
      make(),
      { trigger: 'call', utterance: 'tidy up' },
      new AbortController().signal,
      d
    )
    expect(d.started).toEqual([['mail-buddy', 't_9', 'Mail Buddy: tidy up', 50]])
    expect(d.ended).toEqual([
      ['t_9', { phase: 'done', summary: 'Sorted 4 mails.', costUsd: 0.04, endedAt: 50 }]
    ])
  })

  it('a run that throws after it started ends as failed or cancelled', async () => {
    const ac = new AbortController()
    const d = deps({
      runTask: async (_p, _s, o) => {
        o.underEnvelope.onStart?.('t_8')
        ac.abort()
        throw Object.assign(new Error('stopped'), { name: 'AbortError' })
      }
    })
    await expect(runBuddyForeground(make(), { trigger: 'call' }, ac.signal, d)).rejects.toThrow()
    expect(d.ended).toEqual([['t_8', { phase: 'cancelled', summary: 'Stopped.', endedAt: 50 }]])
  })
})

describe('ScreenRuns', () => {
  it('keeps runs per buddy on disk, newest first; an open one reads as interrupted later', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'screen-runs-')), 'runs.json')
    const r = new ScreenRuns(file)
    r.start('mail-buddy', 't_1', 'Mail Buddy: run now', 10)
    r.end('t_1', { phase: 'done', summary: 'x'.repeat(400), costUsd: 0.02, endedAt: 20 })
    r.start('mail-buddy', 't_2', 'Mail Buddy: tidy', 30)
    r.start('price-buddy', 't_3', 'Price Buddy: run now', 40)
    const list = r.list('mail-buddy')
    expect(list.map((x) => [x.taskId, x.phase])).toEqual([
      ['t_2', 'running'],
      ['t_1', 'done']
    ])
    expect(list[1].summary).toHaveLength(300)
    expect(list[1]).not.toHaveProperty('buddyId')
    const again = new ScreenRuns(file)
    expect(again.list('mail-buddy')[0].phase).toBe('interrupted')
    expect(again.list('price-buddy')).toHaveLength(1)
  })

  it('keeps the newest 20 per buddy and ignores a broken file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'screen-runs-')), 'runs.json')
    const r = new ScreenRuns(file)
    for (let i = 0; i < 25; i++) r.start('mail-buddy', `t_${i}`, 'x', i)
    expect(r.list('mail-buddy')).toHaveLength(20)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(20)
    writeFileSync(file, '{not json')
    expect(new ScreenRuns(file).list('mail-buddy')).toEqual([])
  })
})

describe('the buddy history', () => {
  it('merges on-screen runs with background runs', () => {
    const b = make()
    const store = { list: () => [b], get: () => b } as unknown as BuddyStore
    const task = {
      id: 'bg_1',
      title: 'Mail Buddy: run now',
      phase: 'done',
      buddyId: b.id,
      counters: { startedAt: 10, costUsd: 0.01 }
    } as unknown as BackgroundTask
    const svc = new Buddies({
      store,
      start: vi.fn(),
      tasks: () => [task],
      emit: () => {},
      envelope: () => ({}) as SkillEnvelope
    })
    const screen = new ScreenRuns(null)
    svc.setScreenRuns((id) => screen.list(id))
    screen.start(b.id, 't_1', 'Mail Buddy: tidy', 30)
    expect(svc.runs(b.id).map((r) => r.taskId)).toEqual(['t_1', 'bg_1'])
    const row = svc.summaries()[0]
    expect(row.running).toBe(true)
    expect(row.lastRun?.taskId).toBe('t_1')
    screen.end('t_1', { phase: 'done', endedAt: 40 })
    expect(svc.summaries()[0].running).toBe(false)
  })
})
