// Task chat wiring (08 T43) with the app faked: Claude permission choices, answers bound to the
// question / confirm the view showed, voice steering, and watches ending with the panel window.
import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeSessionView } from '@shared/claude-code'

const h = vi.hoisted(() => ({
  view: null as unknown,
  bridge: { answer: vi.fn(() => true) },
  copilot: {
    get: vi.fn(() => h.view),
    send: vi.fn(),
    answerQuestion: vi.fn(() => true),
    interrupt: vi.fn()
  },
  fg: null as string | null,
  own: null as string | null,
  owner: 't_task01',
  pending: false,
  card: undefined as undefined | { actionId: string; summary: string },
  command: vi.fn(),
  win: null as unknown,
  tasks: [] as unknown[]
}))

vi.mock('electron', () => ({ app: { on: vi.fn() } }))
vi.mock('../../src/main/claude-code', () => ({
  getBridge: () => h.bridge,
  getCopilot: () => h.copilot,
  onSessionChange: vi.fn()
}))
vi.mock('../../src/main/claude-code/session', () => ({ sessionTaps: { on: vi.fn() } }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))
vi.mock('../../src/main/windows/assistant', () => ({
  confirmPending: () => h.pending,
  state: () => ({ confirm: h.card }),
  command: h.command,
  send: vi.fn()
}))
vi.mock('../../src/main/windows/home', () => ({ hide: vi.fn(), send: vi.fn() }))
vi.mock('../../src/main/windows/settings', () => ({
  get: () => h.win,
  send: vi.fn(),
  create: vi.fn()
}))
vi.mock('../../src/main/agent-mode/ask', () => ({
  answerQuestion: vi.fn(() => true),
  askPending: () => false
}))
vi.mock('../../src/main/agent-mode/background', () => ({
  backgroundManager: () => ({
    list: () => h.tasks,
    get: () => undefined,
    isPaused: () => false,
    answer: () => false
  })
}))
vi.mock('../../src/main/agent-mode/confirm', () => ({
  ownedConfirmId: (owner: string) => (owner === h.owner ? h.own : null),
  onConfirmOwnerChange: vi.fn()
}))
vi.mock('../../src/main/agent-mode/session', () => ({
  agentTaskPaused: () => false,
  canPauseAgentTask: () => true,
  pauseAgentTask: () => true,
  resumePausedAgentTask: () => true,
  runningAgentTaskId: () => h.fg,
  stopAgentTask: () => true
}))

import {
  controlChat,
  interceptTaskChat,
  steerChat,
  watchChat
} from '../../src/main/agent-mode/transcript-wire'
import { claudeToken } from '../../src/main/agent-mode/transcript-header'
import { transcripts } from '../../src/main/agent-mode/transcript-hub'

const view = (over: Partial<ClaudeSessionView> = {}): ClaudeSessionView => ({
  id: 'cc_sess01',
  project: 'C:\\code\\app',
  projectName: 'app',
  title: 'app: fix tests',
  phase: 'waiting-permission',
  lastLine: '',
  costUsd: 0,
  turns: 1,
  startedAt: 100,
  lastActive: 200,
  autopilot: 'careful',
  autoAnswers: [],
  commands: [],
  ...over
})

const permA = { kind: 'permission' as const, permId: 'p1', text: 'Claude wants to run npm test' }
const permB = { kind: 'permission' as const, permId: 'p2', text: 'Claude wants to run rm -rf dist' }

beforeEach(() => {
  vi.clearAllMocks()
  h.view = null
  h.fg = null
  h.own = null
  h.pending = false
  h.card = undefined
  h.win = null
  h.tasks = []
})

describe('Claude permission choices in the chat', () => {
  it('Allow / Always allow / Deny answer the permission the view showed', () => {
    h.view = view({ pending: permA })
    const token = claudeToken(permA)
    expect(steerChat('cc_sess01', 'Allow', token)).toMatchObject({ ok: true, how: 'answer' })
    expect(steerChat('cc_sess01', 'Always allow', token).ok).toBe(true)
    expect(steerChat('cc_sess01', 'Deny', token).ok).toBe(true)
    expect(h.bridge.answer.mock.calls).toEqual([
      ['once', 'p1'],
      ['always', 'p1'],
      ['deny', 'p1']
    ])
    expect(steerChat('cc_sess01', 'sure why not', token).ok).toBe(false)
    expect(h.copilot.send).not.toHaveBeenCalled()
  })
})

describe('answers bound to what the view showed', () => {
  it('a Claude permission that changed is not approved with the old one’s token', () => {
    h.view = view({ pending: permB })
    expect(controlChat('cc_sess01', 'approve', claudeToken(permA)).ok).toBe(false)
    expect(steerChat('cc_sess01', 'Allow', claudeToken(permA)).ok).toBe(false)
    expect(h.bridge.answer).not.toHaveBeenCalled()
    expect(controlChat('cc_sess01', 'approve', claudeToken(permB)).ok).toBe(true)
    expect(h.bridge.answer).toHaveBeenCalledWith('once', 'p2')
  })

  it('a foreground confirm: only the task’s own card, and only with its id', () => {
    h.fg = 't_task01'
    h.pending = true
    h.card = { actionId: 'B', summary: 'Delete the draft' }
    h.own = 'B'
    expect(controlChat('t_task01', 'approve', 'A').ok).toBe(false)
    expect(controlChat('t_task01', 'approve').ok).toBe(false)
    h.own = null // another source's card on the bar
    expect(controlChat('t_task01', 'approve', 'B').ok).toBe(false)
    expect(h.command).not.toHaveBeenCalled()
    h.own = 'B'
    h.owner = 't_other1' // tagged with another task's id
    expect(controlChat('t_task01', 'approve', 'B').ok).toBe(false)
    expect(h.command).not.toHaveBeenCalled()
    h.owner = 't_task01'
    expect(controlChat('t_task01', 'deny', 'B').ok).toBe(true)
    expect(h.command).toHaveBeenCalledWith({ type: 'deny' })
  })
})

describe('voice steering', () => {
  it('words with no task name do not go to an idle Claude session', () => {
    h.view = view({ phase: 'idle' })
    transcripts().claudeView(view({ phase: 'idle' }))
    expect(interceptTaskChat('ask the agent to delete the old build files')).toBeUndefined()
    expect(h.copilot.send).not.toHaveBeenCalled()
  })
})

describe('live pushes', () => {
  it('watches end when the panel window closes', () => {
    const win = new EventEmitter()
    h.win = win
    expect(watchChat('bg_watch01', true)).toBe(true)
    expect(transcripts().watched('bg_watch01')).toBe(true)
    win.emit('closed')
    expect(transcripts().watched('bg_watch01')).toBe(false)
  })
})
