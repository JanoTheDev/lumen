// tasks:changed (08 T29 / T43): pushed to the Home window and to the panel window, whose task
// chat list follows it, also for foreground tasks and Claude sessions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeSessionView } from '@shared/claude-code'

const h = vi.hoisted(() => ({
  homeSend: vi.fn(),
  homeVisible: true,
  panelSend: vi.fn(),
  onSession: null as null | ((v: ClaudeSessionView) => void)
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../src/main/windows/home', () => ({
  send: h.homeSend,
  visible: () => h.homeVisible
}))
vi.mock('../../src/main/windows/settings', () => ({ send: h.panelSend }))
vi.mock('../../src/main/claude-code', () => ({
  onSessionChange: (fn: (v: ClaudeSessionView) => void) => (h.onSession = fn)
}))
vi.mock('../../src/main/agent-mode/background', () => ({
  backgroundManager: () => ({ list: () => [], markSeen: vi.fn() })
}))
vi.mock('../../src/main/agent-mode/transcript-wire', () => ({
  chatForTask: vi.fn(),
  chatList: vi.fn(() => []),
  controlChat: vi.fn(),
  openChat: vi.fn(),
  steerChat: vi.fn(),
  watchChat: vi.fn()
}))
vi.mock('../../src/main/agent-mode/transcript-hub', () => ({ transcripts: vi.fn() }))

import { bus } from '../../src/main/bus'
import { registerTasksIpc } from '../../src/main/ipc/tasks'
import type { BackgroundTask } from '@shared/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('tasks:changed', () => {
  it('reaches the panel window too, also for foreground tasks and Claude sessions', () => {
    registerTasksIpc()
    bus.emit({ type: 'task.changed', task: { id: 'bg_x00001' } as BackgroundTask })
    vi.advanceTimersByTime(200)
    expect(h.homeSend).toHaveBeenCalledWith('tasks:changed', [])
    expect(h.panelSend).toHaveBeenCalledWith('tasks:changed', [])
    h.panelSend.mockClear()
    bus.emit({ type: 'agent.task', task: null })
    vi.advanceTimersByTime(200)
    expect(h.panelSend).toHaveBeenCalledTimes(1)
    h.panelSend.mockClear()
    const v = { id: 'cc_s00001', phase: 'thinking', title: 't' } as ClaudeSessionView
    h.onSession?.(v)
    vi.advanceTimersByTime(200)
    // The same phase again (a new output line) does not move the row.
    h.onSession?.({ ...v, lastLine: 'more' })
    vi.advanceTimersByTime(200)
    expect(h.panelSend).toHaveBeenCalledTimes(1)
  })

  it('skips a hidden Home window', () => {
    registerTasksIpc()
    h.homeVisible = false
    h.homeSend.mockClear()
    h.panelSend.mockClear()
    bus.emit({ type: 'task.changed', task: { id: 'bg_x00002' } as BackgroundTask })
    vi.advanceTimersByTime(200)
    expect(h.homeSend).not.toHaveBeenCalled()
    expect(h.panelSend).toHaveBeenCalled()
    h.homeVisible = true
  })
})
