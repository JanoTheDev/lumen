// Lesson wiring (src/main/teach/index.ts) against a fake agent and a temp skills folder.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => home.dir }
})
vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../../src/main/config', async () => {
  const { makeConfig } = await import('../helpers/fixtures')
  // Slow pace: the "do it" offer comes after two minutes, past the one-minute focus pause.
  return { loadConfig: () => makeConfig({ a11y: { timings: { statusHoldMs: 12_000 } } }) }
})
vi.mock('../../src/main/a11y', () => ({ announce: vi.fn(), setLessonActiveProbe: vi.fn() }))
vi.mock('../../src/main/a11y/focus-events', () => ({ wantFocusEvents: vi.fn() }))
vi.mock('../../src/main/query/pipeline', () => ({ setTeachHandler: vi.fn() }))
vi.mock('../../src/main/ai/providers', () => ({
  getProvider: () => {
    throw new Error('no model calls in this test')
  }
}))

import type { AssistantState } from '../../src/shared/events'
import type { AgentBridge } from '../../src/main/agent/bridge'
import { bus } from '../../src/main/bus'
import { setAgent } from '../../src/main/agent/instance'
import { toStoredLesson, type Lesson } from '../../src/main/teach/lesson'
import {
  installTeach,
  interceptLesson,
  lessonCommand,
  lessonProgress,
  sleep,
  startLesson,
  startOrResume
} from '../../src/main/teach'
import { LESSON } from './fixtures'

const A: Lesson = { ...LESSON, id: 'quill-basics-01-a', app: 'quill', title: 'First quill lesson' }
const B: Lesson = { ...LESSON, id: 'quill-basics-02-b', app: 'quill', title: 'Second quill lesson' }

const handlers = new Map<string, ((data: unknown) => void)[]>()
const fg = { title: 'Untitled - Notepad', process: 'notepad.exe' }
const request = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  void args
  if (cmd === 'subscribe') return {}
  if (cmd === 'active_window') return { ...fg, rect: { x: 0, y: 0, w: 800, h: 600 } }
  throw new Error(`E_UNSUPPORTED ${cmd}`)
})
const agent = {
  protocol: 2,
  running: true,
  hasCapability: () => true,
  request,
  onEvent: (event: string, cb: (data: unknown) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), cb])
  }
}
const emit = (event: string, data: unknown = {}): void =>
  handlers.get(event)?.forEach((cb) => cb(data))
const subscribes = (): unknown[] =>
  request.mock.calls.filter(([cmd]) => cmd === 'subscribe').map(([, args]) => args)
let barText: string | undefined
bus.on('lesson.state', (e: { state: AssistantState | null }) => (barText = e.state?.statusText))
const PAUSED = 'Lesson paused. Say resume when you are ready.'

function writePack(root: string): void {
  const dir = join(root, '.ai-overlay', 'skills', 'quill')
  mkdirSync(join(dir, 'lessons'), { recursive: true })
  writeFileSync(
    join(dir, 'skill.json'),
    JSON.stringify({
      id: 'quill',
      name: 'Quill',
      version: '1.0.0',
      match: { process: ['quill.exe'] },
      uiaQuality: 'good'
    })
  )
  for (const l of [A, B])
    writeFileSync(join(dir, 'lessons', `${l.id}.lesson.json`), JSON.stringify(toStoredLesson(l)))
}

beforeAll(() => {
  vi.useFakeTimers()
  home.dir = mkdtempSync(join(tmpdir(), 'lumen-teach-'))
  writePack(home.dir)
  setAgent(agent as unknown as AgentBridge)
  installTeach()
})

afterAll(() => {
  lessonCommand('stop')
  vi.useRealTimers()
})

beforeEach(async () => {
  lessonCommand('stop')
  await vi.advanceTimersByTimeAsync(0)
  request.mockClear()
  fg.title = 'Untitled - Notepad'
  fg.process = 'notepad.exe'
})

describe('teach wiring', () => {
  it('resumes a paused lesson when the picker starts it again', async () => {
    expect(startLesson(A.id)).toBe(true)
    expect(lessonCommand('pause')).toBe(true)
    expect(barText).toBe(PAUSED)
    expect(startOrResume(A.id)).toBe(true)
    expect(barText).toBe(A.steps[0].say)
  })

  it('"teach me …" and "start lesson …" still work while a lesson runs', async () => {
    expect(startLesson(A.id, { stepIndex: 0 })).toBe(true)
    const list = interceptLesson('teach me quill') as { text: string }
    expect(list.text).toMatch(/^Quill lessons: 1, First quill lesson\. 2, Second quill lesson/)
    expect(interceptLesson('start lesson 2')).toMatchObject({ local: true })
    expect(lessonProgress().active?.lessonId).toBe(B.id)
  })

  it('asks the agent for key combos again after it restarts', async () => {
    // Step 2 waits for Ctrl+S.
    expect(startLesson(A.id, { stepIndex: 1 })).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribes()).toEqual([{ events: ['key-combo'], enabled: true }])
    emit('agent-ready')
    expect(subscribes()).toEqual([
      { events: ['key-combo'], enabled: true },
      { events: ['key-combo'], enabled: true }
    ])
  })

  it('time away from one lesson does not count against the next', async () => {
    startLesson(A.id, { stepIndex: 2 })
    await vi.advanceTimersByTimeAsync(30_000)
    startLesson(B.id, { stepIndex: 2 })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(barText).not.toBe(PAUSED)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(barText).toBe(PAUSED)
  })
})

describe('sleep', () => {
  it('rejects at once on an aborted signal and drops its abort listener when done', async () => {
    const ac = new AbortController()
    ac.abort(new Error('gone'))
    await expect(sleep(10, ac.signal)).rejects.toThrow('gone')
    const live = new AbortController()
    const remove = vi.spyOn(live.signal, 'removeEventListener')
    const p = sleep(10, live.signal)
    await vi.advanceTimersByTimeAsync(10)
    await p
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
