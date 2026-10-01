// Steering, pause / resume and transcript records of background tasks (08 T43).
import { describe, expect, it } from 'vitest'
import {
  BackgroundManager,
  MAX_STEERS,
  type RunOutcome,
  type TaskControl,
  type TaskRecord
} from '../../src/main/agent-mode/background/manager'
import { runAgent, type RunnerDeps } from '../../src/main/agent-mode/runner'
import type { AgentMessage, ToolTurnResult } from '../../src/main/ai/providers/types'
import type { RunEvent } from '../../src/main/agent-mode/transcript'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(): {
  m: BackgroundManager
  ctls: TaskControl[]
  finish: (r?: Partial<RunOutcome>) => void
  records: { id: string; e: TaskRecord }[]
} {
  const ctls: TaskControl[] = []
  const records: { id: string; e: TaskRecord }[] = []
  let resolve: (r: RunOutcome) => void = () => {}
  let n = 0
  const m = new BackgroundManager({
    max: () => 2,
    run: (ctl) =>
      new Promise<RunOutcome>((res, rej) => {
        ctls.push(ctl)
        resolve = res
        ctl.signal.addEventListener('abort', () => rej(new Error('aborted')))
      }),
    emit: () => {},
    record: (id, e) => records.push({ id, e }),
    now: () => 1000 + n,
    newId: () => `bg_steer${n++}`
  })
  return { m, ctls, finish: (r = {}) => resolve({ status: 'done', summary: 'ok', ...r }), records }
}

describe('background steering', () => {
  it('queues steer messages until the next step takes them', async () => {
    const { m, ctls, records } = setup()
    const t = m.start({ prompt: 'check my email', origin: 'voice' })
    expect(m.steer(t.id, '  also   check Outlook ')).toBe(true)
    expect(m.steer(t.id, 'and the spam folder')).toBe(true)
    expect(await ctls[0].between!(ctls[0].signal)).toEqual([
      'also check Outlook',
      'and the spam folder'
    ])
    expect(await ctls[0].between!(ctls[0].signal)).toEqual([])
    expect(records.filter((r) => r.e.type === 'steer')).toHaveLength(2)
  })

  it('refuses empty, too many, own-runner and ended tasks', async () => {
    const { m, finish } = setup()
    const t = m.start({ prompt: 'a task', origin: 'voice' })
    expect(m.steer(t.id, '   ')).toBe(false)
    for (let i = 0; i < MAX_STEERS; i++) expect(m.steer(t.id, `note ${i}`)).toBe(true)
    expect(m.steer(t.id, 'one too many')).toBe(false)
    const own = m.start({
      prompt: 'claude',
      origin: 'voice',
      run: () => new Promise<RunOutcome>(() => {})
    })
    expect(m.steer(own.id, 'hello there')).toBe(false)
    expect(m.steerable(own.id)).toBe(false)
    finish()
    await tick()
    expect(m.steer(t.id, 'too late now')).toBe(false)
  })

  it('pause holds the next step until resume; cancel wakes it', async () => {
    const { m, ctls } = setup()
    const t = m.start({ prompt: 'long research', origin: 'voice' })
    expect(m.pause(t.id)).toBe(true)
    expect(m.pause(t.id)).toBe(false)
    expect(m.isPaused(t.id)).toBe(true)
    expect(m.get(t.id)!.progress).toContain('Paused')
    let passed = false
    const gate = ctls[0].between!(ctls[0].signal).then((n) => {
      passed = true
      return n
    })
    await tick()
    expect(passed).toBe(false)
    m.steer(t.id, 'look at the second link too')
    expect(m.resume(t.id)).toBe(true)
    expect(await gate).toEqual(['look at the second link too'])
    // Paused again, then cancelled: the waiting step wakes and the run ends cancelled.
    m.pause(t.id)
    const waiting = ctls[0].between!(ctls[0].signal)
    m.cancel(t.id)
    await expect(waiting).resolves.toEqual([])
    await tick()
    expect(m.get(t.id)!.phase).toBe('cancelled')
    expect(m.isPaused(t.id)).toBe(false)
  })

  it('records start, questions, answers and the end for the transcript', async () => {
    const { m, ctls, finish, records } = setup()
    const t = m.start({ prompt: 'plan my trip', origin: 'voice' })
    const asked = ctls[0].ask('Which city?', ['Rome', 'Oslo'])
    m.answer(t.id, 'Rome')
    await asked
    ctls[0].record!({ type: 'model', text: 'Looking at flights.' })
    finish({ summary: 'Booked nothing, found three flights.' })
    await tick()
    expect(records.map((r) => r.e.type)).toEqual(['start', 'question', 'answer', 'run', 'end'])
    const end = records[records.length - 1].e
    expect(end.type === 'end' && end.task.phase).toBe('done')
  })

  it('a steer message the task never read is recorded before the end', async () => {
    const { m, finish, records } = setup()
    const t = m.start({ prompt: 'check my email', origin: 'voice' })
    expect(m.steer(t.id, 'also check spam')).toBe(true)
    finish({ summary: 'Done.' })
    await tick()
    const types = records.map((r) => r.e.type)
    expect(types.slice(-2)).toEqual(['unread', 'end'])
    expect(records.find((r) => r.e.type === 'unread')?.e).toEqual({
      type: 'unread',
      texts: ['also check spam']
    })
  })
})

describe('runner hooks', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const turn = (text: string, calls: ToolTurnResult['message']['calls']): ToolTurnResult => ({
    message: { role: 'assistant', text, calls },
    usage,
    model: 'fake',
    stopReason: calls.length ? 'tool_use' : 'end_turn'
  })

  it('reports model text, calls and results, and adds steer notes before a turn', async () => {
    const seen: AgentMessage[][] = []
    const events: RunEvent[] = []
    const script = [
      turn('Let me look.', [{ id: 'c1', name: 'observe', input: { what: 'window' } }]),
      turn('', [{ id: 'c2', name: 'finish', input: { summary: 'Done.' } }])
    ]
    let i = 0
    let notes = [['first note']]
    const deps: RunnerDeps = {
      model: {
        plan: async () => ({ plan: null }),
        turn: async (req) => {
          seen.push(req.messages)
          return script[i++]
        }
      },
      handlers: { observe: async () => ({ content: [{ type: 'text', text: 'Inbox' }] }) },
      publish: () => {},
      speak: () => {},
      countdown: async () => 'go',
      askContinue: async () => false,
      costOf: () => 0,
      now: () => Date.now(),
      observe: (e) => events.push(e),
      between: async () => {
        const n = notes[0] ?? []
        notes = []
        return n
      }
    }
    await runAgent(
      { prompt: 'x', context: {}, tools: ['observe', 'finish'], cancelWindowMs: 0, skipPlan: true },
      deps
    )
    expect(events.map((e) => e.type)).toEqual(['model', 'call', 'result'])
    const first = seen[0][0]
    expect(first.role === 'user' && first.content.map((c) => c.type)).toEqual(['text', 'text'])
    expect(JSON.stringify(seen[0])).toContain('first note')
    // Taken once: the next turn still has it in the history, not a second time.
    expect(JSON.stringify(seen[1]).split('first note')).toHaveLength(2)
  })
})
