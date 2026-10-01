import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../src/main/agent-mode/session', () => ({
  agentCommand: vi.fn(() => true),
  agentRunning: vi.fn(() => false),
  hasPausedTask: vi.fn(() => false)
}))

import type { AgentTask } from '../src/shared/events'
import type { AssistantView } from '../src/shared/channels'
import { bus } from '../src/main/bus'
import { setConfigDir } from '../src/main/config'
import * as assistant from '../src/main/windows/assistant'
import { FocusReturn, LOOKUP_MS, hwndOf } from '../src/main/windows/focus-return'
import { agentBarCommand } from '../src/main/ipc/ui'
import * as session from '../src/main/agent-mode/session'
import { currentStep, revealText, simpleRow } from '../src/renderer/src/assistant/model'
import { barSettings } from '../src/renderer/src/assistant/useBarSettings'
import { filterSections } from '../src/renderer/src/panel/settings/meta'
import { tempDir } from './helpers/fixtures'

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: 'k1',
  prompt: 'draft an email to Sam',
  summary: 'draft an email to Sam',
  plan: ['Open Mail', 'Write it'],
  steps: [
    { i: 1, label: 'Open Mail', status: 'done' },
    { i: 2, label: 'Write it', status: 'running' }
  ],
  phase: 'running',
  counters: { actions: 1, modelCalls: 1, costUsd: 0, startedAt: 0 },
  ...over
})

describe('streaming reveal', () => {
  it('shows whole words only while streaming', () => {
    expect(revealText('The Compose but', true)).toBe('The Compose ')
    expect(revealText('The Compose button ', true)).toBe('The Compose button ')
    expect(revealText('The Compose but', false)).toBe('The Compose but')
    expect(revealText('One', true)).toBe('')
  })
})

describe('simple mode', () => {
  const base: AssistantView = { phase: 'idle', visible: true, autoCloseMs: 0 }

  it('picks one row: confirm, then answer or error, then the task, step, notice, line, caption', () => {
    const answer = { turnId: 't', markdown: 'Hi', streaming: false, pinned: false }
    const confirm = { actionId: 'a', summary: 'Send', risk: 'low' as const }
    expect(simpleRow({ ...base, caption: 'hi', answer, confirm })).toBe('confirm')
    expect(simpleRow({ ...base, caption: 'hi', answer })).toBe('answer')
    expect(simpleRow({ ...base, caption: 'hi', error: { message: 'x' } })).toBe('answer')
    expect(simpleRow({ ...base, caption: 'hi', agentTask: task() })).toBe('task')
    expect(simpleRow({ ...base, caption: 'hi' })).toBe('caption')
    expect(simpleRow(base)).toBeNull()
  })

  it('shows the step in progress, else the failed or next one', () => {
    expect(currentStep(task())?.i).toBe(2)
    const failed = task({
      steps: [
        { i: 1, label: 'a', status: 'failed' },
        { i: 2, label: 'b', status: 'pending' }
      ]
    })
    expect(currentStep(failed)?.i).toBe(1)
    expect(currentStep(task({ steps: [] }))).toBeUndefined()
  })

  it('reads simple mode, private mode and shortcut hints from config', () => {
    const s = barSettings({
      a11y: { simpleMode: true, shortcuts: { repeat: 'Ctrl+Shift+F3', pin: '', close: 'F5' } },
      memory: { enabled: true, privateMode: true }
    })
    expect(s).toMatchObject({ simple: true, privateMode: true, memory: true })
    expect(s.keys).toEqual({ repeat: 'Ctrl+Shift+F3', pin: undefined, close: 'F5' })
    expect(barSettings({ memory: { enabled: false, privateMode: true } }).privateMode).toBe(false)
    expect(barSettings(null).simple).toBe(false)
  })

  it('settings lists essentials only in simple mode, and search still finds everything', () => {
    const all = filterSections('').map((s) => s.id)
    const few = filterSections('', true).map((s) => s.id)
    expect(few.length).toBeLessThan(all.length)
    expect(few).toEqual(expect.arrayContaining(['general', 'voice', 'accessibility', 'about']))
    expect(few).not.toContain('memory')
    expect(filterSections('memory', true).map((s) => s.id)).toEqual(['memory'])
    for (const q of ['simple mode', 'eye gaze', 'head pointer'])
      expect(filterSections(q).map((s) => s.id)).toEqual(['accessibility'])
  })
})

describe('focused mode: focus return', () => {
  it('remembers the foreground window unless it is the bar, and gives it back once', async () => {
    const focus = vi.fn(async () => {})
    const r = new FocusReturn({ current: async () => 42, focus })
    await r.remember([7])
    expect(r.take()).toBe(42)
    expect(r.take()).toBeNull()

    const own = new FocusReturn({ current: async () => 7, focus })
    await own.remember([7])
    expect(own.take()).toBeNull()

    r.focus(42)
    expect(focus).toHaveBeenCalledWith(42)
  })

  it('does not wait on a slow agent and forgets when the user moved on', async () => {
    vi.useFakeTimers()
    const r = new FocusReturn({ current: () => new Promise(() => {}), focus: async () => {} })
    const p = r.remember([])
    await vi.advanceTimersByTimeAsync(LOOKUP_MS)
    await p
    expect(r.take()).toBeNull()
    vi.useRealTimers()

    const s = new FocusReturn({ current: async () => 9, focus: async () => {} })
    await s.remember([])
    s.forget()
    expect(s.take()).toBeNull()
  })

  it('reads a native window handle', () => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(0x1234n)
    expect(hwndOf(b)).toBe(0x1234)
    expect(hwndOf(undefined)).toBeNull()
  })
})

describe('agent step list wiring', () => {
  let tmp: ReturnType<typeof tempDir>

  beforeEach(() => {
    tmp = tempDir()
    setConfigDir(tmp.dir)
    vi.mocked(session.agentRunning).mockReturnValue(false)
    vi.mocked(session.hasPausedTask).mockReturnValue(false)
    vi.mocked(session.agentCommand).mockClear()
  })
  afterEach(() => {
    assistant.close()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('merges agent.task into the bar and keeps it busy until the task ends', () => {
    bus.emit({ type: 'agent.task', task: task() })
    expect(assistant.state().agentTask?.id).toBe('k1')
    expect(assistant.state().visible).toBe(true)
    // A new recording (the user answering) keeps the task on the bar.
    assistant.open('listening')
    expect(assistant.state().agentTask?.id).toBe('k1')
    assistant.turnEnded()
    expect(assistant.state().visible).toBe(true)
    bus.emit({ type: 'agent.task', task: null })
    expect(assistant.state().agentTask).toBeUndefined()
  })

  it('routes Start now and choices to the task, and Retry resumes or asks again', () => {
    const run = vi.fn()
    expect(agentBarCommand({ type: 'go' }, run)).toBe(true)
    expect(session.agentCommand).toHaveBeenCalledWith({ type: 'go' })
    agentBarCommand({ type: 'answer', text: 'Sam Lee' }, run)
    expect(session.agentCommand).toHaveBeenCalledWith({ type: 'answer', text: 'Sam Lee' })

    agentBarCommand({ type: 'retry', step: 2 }, run, task({ phase: 'failed' }))
    expect(run).toHaveBeenLastCalledWith('draft an email to Sam')
    vi.mocked(session.hasPausedTask).mockReturnValue(true)
    agentBarCommand({ type: 'retry', step: 2 }, run, task({ phase: 'paused' }))
    expect(run).toHaveBeenLastCalledWith('resume the task')
    vi.mocked(session.agentRunning).mockReturnValue(true)
    run.mockClear()
    agentBarCommand({ type: 'retry', step: 2 }, run, task())
    expect(run).not.toHaveBeenCalled()

    expect(agentBarCommand({ type: 'close' }, run)).toBe(false)
  })

  it('Repeat without an answer says the line that matters most', () => {
    const v: AssistantView = { phase: 'acting', visible: true, autoCloseMs: 0 }
    expect(assistant.repeatLine({ ...v, statusText: 'Thinking…', caption: 'hi' })).toBe('Thinking')
    expect(assistant.repeatLine({ ...v, agentTask: task(), statusText: 'x' })).toBe('Write it')
    expect(assistant.repeatLine({ ...v, error: { message: 'No key' }, statusText: 'x' })).toBe(
      'No key'
    )
    expect(assistant.repeatLine({ ...v, caption: 'hi' })).toBe('hi')
  })
})
