// Task chat hub, store, headers and voice matching (08 T43).
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ClaudeSessionView } from '@shared/claude-code'
import type { ChatDelta, ChatHeader } from '@shared/task-chat'
import {
  chatControlSchema,
  chatIdSchema,
  chatSteerSchema,
  chatWatchSchema
} from '@shared/task-chat'
import type { BackgroundTask } from '@shared/types'
import { TranscriptHub, type HubDeps } from '../../src/main/agent-mode/transcript-hub'
import { TranscriptStore } from '../../src/main/agent-mode/transcript-store'
import {
  backgroundHeader,
  chatSummaries,
  claudeHeader,
  foregroundHeader
} from '../../src/main/agent-mode/transcript-header'
import { matchTaskChatIntent, pickChat } from '../../src/main/agent-mode/transcript-voice'
import { tempDir } from '../helpers/fixtures'

let tmp: ReturnType<typeof tempDir> | null = null
afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

function hubWith(store?: TranscriptStore): {
  hub: TranscriptHub
  timers: (() => void)[]
} {
  const timers: (() => void)[] = []
  const deps: HubDeps = {
    now: () => 5000,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {}
  }
  const hub = new TranscriptHub(deps)
  if (store) hub.setStore(store)
  return { hub, timers }
}

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'bg_hub001',
  title: 'Check my email',
  prompt: 'check my email',
  origin: 'voice',
  phase: 'running',
  progress: [],
  counters: { modelCalls: 2, costUsd: 0.02, startedAt: 1000 },
  ...over
})

const header = (id: string): ChatHeader => ({
  id,
  kind: 'background',
  title: 't',
  phase: 'running',
  steps: 0,
  modelCalls: 0,
  costUsd: 0,
  startedAt: 0,
  canStop: true,
  canPause: true,
  canResume: false,
  canRunAgain: false,
  canSteer: true
})

describe('TranscriptHub', () => {
  it('builds a background transcript from manager records and pushes only to watchers', () => {
    const { hub } = hubWith()
    hub.setHeaderSource(header)
    const t = task()
    const pushed: ChatDelta[] = []
    hub.background(t.id, { type: 'start', task: t })
    const off = hub.watch(t.id, (d) => pushed.push(d))
    hub.background(t.id, {
      type: 'run',
      ev: { type: 'call', call: { id: 'c1', name: 'fetch_url', input: { url: 'https://a.com/x' } } }
    })
    hub.background(t.id, { type: 'steer', text: 'also check Outlook' })
    off()
    hub.background(t.id, {
      type: 'end',
      task: { ...t, phase: 'done', result: { summary: 'All read.' } }
    })
    expect(pushed.map((d) => d.entries?.[0].k)).toEqual(['tool', 'user'])
    const v = hub.view(t.id)!
    expect(v.entries.map((e) => e.k)).toEqual(['user', 'tool', 'user', 'result'])
    expect(v.entries[1]).toMatchObject({ status: 'error', result: 'Stopped.' })
    expect(v.entries[2]).toMatchObject({ steer: true })
    hub.touch(t.id)
    expect(pushed).toHaveLength(2)
  })

  it('leaves Claude tasks to the session transcript', () => {
    const { hub } = hubWith()
    const t = task({
      id: 'bg_claude1',
      claude: { id: 'cc_sess01', projectName: 'p', phase: 'thinking' }
    })
    hub.background(t.id, { type: 'start', task: t })
    hub.background(t.id, { type: 'question', text: 'Allow?' })
    expect(hub.rec(t.id).entries).toHaveLength(0)
  })

  it('saves a moment later, at once on the end, and loads it back', () => {
    tmp = tempDir()
    const store = new TranscriptStore(tmp.dir)
    const { hub, timers } = hubWith(store)
    hub.foregroundStart('t_fore01', 'open notepad and write hi')
    expect(timers).toHaveLength(1)
    expect(existsSync(join(tmp.dir, 't_fore01.json'))).toBe(false)
    timers[0]()
    expect(existsSync(join(tmp.dir, 't_fore01.json'))).toBe(true)
    hub.foregroundEnd('t_fore01', { status: 'done', summary: 'Wrote hi.' })
    const { hub: again } = hubWith(store)
    expect(again.meta('t_fore01')).toMatchObject({ kind: 'foreground', phase: 'done' })
    expect(again.rec('t_fore01').entries.map((e) => e.k)).toEqual(['user', 'result'])
    expect(again.metas().map((m) => m.id)).toEqual(['t_fore01'])
  })

  it('keeps foreground steer messages until the runner drains them', () => {
    const { hub } = hubWith()
    hub.foregroundStart('t_fore02', 'fill the form')
    expect(hub.steer('t_fore02', 'use my work address')).toBe(true)
    expect(hub.drain('t_fore02')).toEqual(['use my work address'])
    expect(hub.drain('t_fore02')).toEqual([])
    expect(hub.rec('t_fore02').entries[1]).toMatchObject({ k: 'user', steer: true })
  })

  it('maps Claude stream events, permissions and autopilot answers', () => {
    const { hub } = hubWith()
    const id = 'cc_sess02'
    const view = (over: Partial<ClaudeSessionView> = {}): ClaudeSessionView => ({
      id,
      project: 'C:\\code\\app',
      projectName: 'app',
      title: 'app: fix tests',
      phase: 'thinking',
      lastLine: '',
      costUsd: 0.1,
      turns: 1,
      startedAt: 100,
      lastActive: 200,
      autopilot: 'careful',
      autoAnswers: [],
      commands: [],
      ...over
    })
    hub.claudeUser(view(), id, 'fix the failing test')
    hub.claudeEvent(id, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running the tests.' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }
        ]
      }
    })
    hub.claudeEvent(id, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '1 failed', is_error: true }]
      }
    })
    hub.claudeView(
      view({ pending: { kind: 'permission', text: 'Claude wants to run', command: 'rm x' } })
    )
    hub.claudeView(view())
    hub.claudeUser(
      view({ autoAnswers: [{ question: 'Q', answer: 'yes', reason: 'safe', at: 5000 }] }),
      id,
      'yes'
    )
    const e = hub.rec(id).entries
    expect(e.map((x) => x.k)).toEqual(['user', 'assistant', 'tool', 'question', 'user', 'status'])
    expect(e[2]).toMatchObject({ label: 'Running npm test', status: 'error', result: '1 failed' })
    expect(e[3]).toMatchObject({ answer: 'Answered', choices: ['Allow', 'Always allow', 'Deny'] })
    expect(e[5]).toMatchObject({ text: 'Autopilot answered for you (safe)' })
    expect(hub.meta(id)).toMatchObject({
      kind: 'claude',
      project: 'app',
      title: 'Claude: app: fix tests'
    })
  })
})

describe('TranscriptStore', () => {
  it('skips bad ids and files, and prunes orphans', () => {
    tmp = tempDir()
    const store = new TranscriptStore(tmp.dir)
    store.save({ id: '../evil', entries: [], dropped: 0 })
    expect(store.ids()).toEqual([])
    store.save({ id: 'bg_keep01', entries: [], dropped: 0 })
    store.save({ id: 'bg_gone01', entries: [], dropped: 0 })
    for (let i = 0; i < 4; i++) store.save({ id: `t_fg000${i}`, entries: [], dropped: 0 })
    writeFileSync(join(tmp.dir, 'cc_bad001.json'), '{not json')
    expect(store.load('cc_bad001')).toBeNull()
    const kept = store.prune(new Set(['bg_keep01']), 2)
    expect(kept).toContain('bg_keep01')
    expect(store.ids()).not.toContain('bg_gone01')
    expect(store.ids().filter((i) => !i.startsWith('bg_'))).toHaveLength(2)
  })
})

describe('chat headers', () => {
  it('background: buttons follow the phase and pause', () => {
    const h = backgroundHeader(task(), { paused: false, steps: 3, steerable: true })
    expect(h).toMatchObject({
      phase: 'running',
      canStop: true,
      canPause: true,
      canResume: false,
      canSteer: true
    })
    const p = backgroundHeader(task(), { paused: true, steps: 3, steerable: true })
    expect(p).toMatchObject({ phase: 'paused', canPause: false, canResume: true })
    const done = backgroundHeader(task({ phase: 'failed' }), {
      paused: false,
      steps: 0,
      steerable: false
    })
    expect(done).toMatchObject({ canStop: false, canRunAgain: true, canSteer: false })
    const q = backgroundHeader(
      task({ phase: 'needs-foreground', question: { text: 'Mouse?', choices: ['Do it now'] } }),
      {
        paused: false,
        steps: 0,
        steerable: true
      }
    )
    expect(q).toMatchObject({
      phase: 'asking',
      question: { text: 'Mouse?', choices: ['Do it now'] }
    })
  })

  it('foreground: a task that is not running any more reads as interrupted', () => {
    const meta = {
      kind: 'foreground' as const,
      title: 'X',
      phase: 'running' as const,
      startedAt: 1,
      modelCalls: 0,
      costUsd: 0
    }
    expect(foregroundHeader('t_a0001', meta, { running: false, steps: 0 }).phase).toBe(
      'interrupted'
    )
    const live = foregroundHeader('t_a0001', meta, { running: true, steps: 1, confirm: 'Send it?' })
    expect(live).toMatchObject({
      phase: 'confirm',
      confirm: 'Send it?',
      canStop: true,
      canSteer: true
    })
  })

  it('claude: no live session means no buttons', () => {
    const meta = {
      kind: 'claude' as const,
      title: 'Claude: x',
      phase: 'running' as const,
      startedAt: 1,
      modelCalls: 1,
      costUsd: 0
    }
    expect(claudeHeader('cc_x0001', null, meta, 0)).toMatchObject({
      phase: 'interrupted',
      canStop: false,
      canSteer: false
    })
    expect(claudeHeader('cc_x0001', null, undefined, 0)).toBeNull()
  })

  it('lists open chats first and folds a session’s tasks into its chat', () => {
    const list = chatSummaries(
      [
        task({
          id: 'bg_old001',
          phase: 'done',
          counters: { modelCalls: 0, costUsd: 0, startedAt: 10 }
        }),
        task({ id: 'bg_new001', counters: { modelCalls: 0, costUsd: 0, startedAt: 20 } }),
        task({ id: 'bg_kid001', parentId: 'bg_new001' }),
        task({
          id: 'bg_cc0001',
          title: 'Claude: app',
          claude: { id: 'cc_s00001', projectName: 'app', phase: 'thinking' },
          counters: { modelCalls: 0, costUsd: 0, startedAt: 30 }
        })
      ],
      [
        {
          id: 't_f00001',
          meta: {
            kind: 'foreground',
            title: 'Old fg',
            phase: 'running',
            startedAt: 40,
            modelCalls: 0,
            costUsd: 0
          }
        }
      ],
      { runningFg: null }
    )
    expect(list.map((s) => s.id)).toEqual(['cc_s00001', 'bg_new001', 't_f00001', 'bg_old001'])
    expect(list[2].phase).toBe('interrupted')
  })
})

describe('task chat voice', () => {
  it('matches show and steer phrases', () => {
    expect(matchTaskChatIntent('Show me what the email task is doing')).toEqual({
      kind: 'show',
      name: 'email'
    })
    expect(matchTaskChatIntent('what is the background task doing?')).toEqual({
      kind: 'show',
      name: ''
    })
    expect(matchTaskChatIntent('open the task chat')).toEqual({ kind: 'show', name: '' })
    expect(matchTaskChatIntent('Tell the background task to also check Outlook')).toEqual({
      kind: 'steer',
      name: '',
      text: 'also check Outlook'
    })
    expect(matchTaskChatIntent('tell the price task to skip Amazon')).toMatchObject({
      name: 'price',
      text: 'skip Amazon'
    })
    expect(matchTaskChatIntent('open the task manager')).toBeNull()
    expect(matchTaskChatIntent('tell Sam I am late')).toBeNull()
    expect(matchTaskChatIntent('tell the task to stop')).toBeNull()
  })

  it('picks the chat a name means', () => {
    const rows = [
      {
        id: 'bg_a00001',
        kind: 'background' as const,
        title: 'Check the lamp price',
        phase: 'done' as const,
        at: 1
      },
      {
        id: 'bg_b00001',
        kind: 'background' as const,
        title: 'Summarize my emails',
        phase: 'running' as const,
        at: 2
      }
    ]
    expect(pickChat('email', rows)?.id).toBe('bg_b00001')
    expect(pickChat('lamp', rows)?.id).toBe('bg_a00001')
    expect(pickChat('', rows)?.id).toBe('bg_b00001')
    expect(pickChat('weather', rows)).toBeNull()
  })
})

describe('task chat ipc payloads', () => {
  it('validates ids, watch, steer and control', () => {
    expect(chatIdSchema.safeParse('bg_abc123').success).toBe(true)
    expect(chatIdSchema.safeParse('t_abc1').success).toBe(true)
    expect(chatIdSchema.safeParse('cc_abc123').success).toBe(true)
    expect(chatIdSchema.safeParse('../x').success).toBe(false)
    expect(chatIdSchema.safeParse('bg_ABC123').success).toBe(false)
    expect(chatWatchSchema.safeParse(['bg_abc123', true]).success).toBe(true)
    expect(chatWatchSchema.safeParse(['bg_abc123', 'yes']).success).toBe(false)
    expect(chatSteerSchema.safeParse({ id: 'bg_abc123', text: 'hi' }).success).toBe(true)
    expect(chatSteerSchema.safeParse({ id: 'bg_abc123', text: '   ' }).success).toBe(false)
    expect(chatSteerSchema.safeParse({ id: 'bg_abc123', text: 'x'.repeat(2001) }).success).toBe(
      false
    )
    expect(chatSteerSchema.safeParse({ id: 'bg_abc123', text: 'hi', extra: 1 }).success).toBe(false)
    expect(chatControlSchema.safeParse({ id: 'cc_abc123', op: 'pause' }).success).toBe(true)
    expect(chatControlSchema.safeParse({ id: 'cc_abc123', op: 'delete' }).success).toBe(false)
  })
})
