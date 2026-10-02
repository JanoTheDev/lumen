// A buddy on screen (08 T52 gap): the overall usage limits (05 T45) refuse an on-screen run
// before it starts, through the `setBuddyRunCheck` port; background runs keep theirs in runBuddy.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Buddy } from '@shared/buddies'

const h = vi.hoisted(() => ({
  buddy: null as unknown,
  runTask: vi.fn(),
  runBuddy: vi.fn()
}))

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }))
vi.mock('../../src/main/agent/instance', () => ({
  requireAgent: () => ({ activeWindow: async () => 'Mail' })
}))
vi.mock('../../src/main/agent-mode/background', () => ({
  backgroundManager: () => ({ list: () => [] }),
  notice: vi.fn(),
  userBusy: () => false
}))
vi.mock('../../src/main/agent-mode/background/manager', () => ({ isOpen: () => false }))
vi.mock('../../src/main/agent-mode/background/presence', () => ({ PRESENT_MS: 120_000 }))
vi.mock('../../src/main/agent-mode/skill-envelope', () => ({ skillEnvelope: () => ({}) }))
vi.mock('../../src/main/agent-mode/session', () => ({
  agentRunning: () => false,
  runAgentTask: h.runTask,
  runningAgentTaskId: () => null,
  stopAgentTask: () => false
}))
vi.mock('../../src/main/bus', () => ({ bus: { emit: vi.fn(), on: vi.fn() } }))
vi.mock('../../src/main/config', () => ({
  configPath: () => '/nowhere/config.json',
  loadConfig: () => ({ agent: { background: { quiet: false } } })
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/query/context', () => ({ windowOnlyContext: () => ({}) }))
vi.mock('../../src/main/routines', () => ({}))
vi.mock('../../src/main/usage/limits', () => ({ canStartRun: () => ({ ok: true }) }))
vi.mock('../../src/main/routines/preapproval', () => ({ allowsForeground: () => false }))
vi.mock('../../src/main/routines/triggers', () => ({ setBuddyNamer: vi.fn() }))
vi.mock('../../src/main/windows/assistant', () => ({}))
vi.mock('../../src/main/buddies/creation-voice', () => ({
  buddyCreationTurn: async () => false,
  setBuddyScheduler: vi.fn()
}))
vi.mock('../../src/main/buddies/schedule', () => ({ BuddyPauseFlag: class {} }))
vi.mock('../../src/main/buddies/index', () => ({
  buddies: () => null,
  buddyNotebook: () => '',
  buddyRuns: () => [],
  buddySummaries: () => [],
  getBuddy: () => h.buddy,
  ledgerSpend: () => null,
  listBuddies: () => [],
  runBuddy: h.runBuddy,
  setBuddyEnabled: () => null,
  updateBuddy: () => null
}))

import { clampBuddy } from '../../src/main/buddies/clamp'
import { setBuddyRunCheck, startBuddyNow } from '../../src/main/buddies/calling'

const onScreen = (): Buddy =>
  clampBuddy(
    'mail-buddy',
    {
      name: 'Mail Buddy',
      instructions: 'Sort my mail.',
      trust: 'mine',
      permissions: { input: true, screen: true }
    },
    { now: 1 }
  )

beforeEach(() => {
  h.buddy = onScreen()
  h.runTask.mockReset()
  h.runTask.mockResolvedValue({ mode: 'answer', text: 'Done.' })
  setBuddyRunCheck(null)
})

describe('on-screen runs and the usage limits', () => {
  it('a paused overall limit refuses the run before the task starts', () => {
    const asked: string[] = []
    setBuddyRunCheck((id) => {
      asked.push(id)
      return { ok: false, reason: 'Lumen reached its monthly limit.' }
    })
    const out = startBuddyNow('mail-buddy', { trigger: 'call' })
    expect(out).toEqual({
      ok: false,
      code: 'E_BUDGET',
      error: 'Lumen reached its monthly limit.'
    })
    expect(asked).toEqual(['mail-buddy'])
    expect(h.runTask).not.toHaveBeenCalled()
  })

  it('runs on screen when the limit allows it', async () => {
    setBuddyRunCheck(() => ({ ok: true }))
    const out = startBuddyNow('mail-buddy', { trigger: 'call' })
    expect(out).toMatchObject({ ok: true, lane: 'foreground' })
    if (out.ok && out.lane === 'foreground') await out.response
    expect(h.runTask).toHaveBeenCalledTimes(1)
  })
})
