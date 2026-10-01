import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const openExternal = vi.fn(async () => {})
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternal(url) },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }),
    dipToScreenPoint: (p: unknown) => p,
    screenToDipPoint: (p: unknown) => p,
    screenToDipRect: (_w: unknown, r: unknown) => r
  }
}))
vi.mock('../../src/main/util', () => ({ sleep: async () => {} }))
vi.mock('../../src/main/ai/observe', () => ({
  waitForSettle: async () => ({ reason: 'timeout', ms: 0 })
}))
vi.mock('../../src/main/windows/highlight', () => ({
  send: vi.fn(),
  show: vi.fn(),
  hide: vi.fn()
}))
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn() }))
vi.mock('../../src/main/query/refine', () => ({
  needsRefine: () => false,
  canRefine: () => false,
  refineTarget: vi.fn()
}))
vi.mock('../../src/main/ai/app-context', () => ({ isBrowser: () => true }))

import type { Action } from '@shared/types'
import { executeActions } from '../../src/main/actions/executor'
import { gate } from '../../src/main/actions/policy'
import { newTaskState } from '../../src/main/actions/safety'
import { setAgent } from '../../src/main/agent/instance'
import type { AgentBridge } from '../../src/main/agent/bridge'
import {
  answerAlways,
  confirmAlways,
  setConfirmUi,
  type ConfirmCard
} from '../../src/main/agent-mode/confirm'
import { grants, installGrants } from '../../src/main/agent-mode/grants'
import { installAudit, listAudit, uninstallAudit } from '../../src/main/audit/log'
import { setConfigDir } from '../../src/main/config'
import { tempDir } from '../helpers/fixtures'

interface Fake {
  window: { title: string; process: string }
  /** focus_info beyond the window; null = the agent cannot read the focus. */
  focus: Record<string, unknown> | null
  executed: Record<string, unknown>[]
}

function fakeAgent(window = { title: 'Untitled - Notepad', process: 'notepad.exe' }): Fake {
  const f: Fake = {
    window,
    focus: { uia: true, role: 'edit', name: 'Text', password: false },
    executed: []
  }
  setAgent({
    hasCapability: () => false,
    activeWindow: async () => f.window.title,
    execute: async (a: Record<string, unknown>) => {
      f.executed.push(a)
      return null
    },
    request: async (cmd: string) => {
      if (cmd === 'active_window') return f.window
      if (cmd === 'focus_info') {
        if (!f.focus) throw new Error('E_UNSUPPORTED')
        return { ...f.window, ...f.focus }
      }
      return {}
    }
  } as unknown as AgentBridge)
  return f
}

/** Confirm UI answering with `answer`; records the cards it was shown. */
function fakeUi(answer: 'yes' | 'no' | 'always'): ConfirmCard[] {
  const cards: ConfirmCard[] = []
  let resolve: ((ok: boolean) => void) | null = null
  setConfirmUi({
    ask: (card) =>
      new Promise<boolean>((r) => {
        cards.push(card)
        resolve = r
        if (answer === 'always') expect(answerAlways('Always')).toBe(true)
        else r(answer === 'yes')
      }),
    confirm: () => resolve?.(true)
  })
  return cards
}

const today = (): string => new Date().toISOString().slice(0, 10)

describe('policy gate', () => {
  let tmp: ReturnType<typeof tempDir>

  beforeEach(() => {
    tmp = tempDir()
    setConfigDir(tmp.dir)
    installGrants(`${tmp.dir}/grants.json`)
    installAudit(`${tmp.dir}/audit`)
    openExternal.mockClear()
  })
  afterEach(() => {
    setAgent(null)
    setConfirmUi(null)
    uninstallAudit()
    setConfigDir(null)
    tmp.cleanup()
  })

  describe('a file: URL is denied through every entry point', () => {
    const bad: Action[] = [{ type: 'open_url', url: 'file:///C:/Windows/System32/calc.exe' }]

    it.each(['user-direct', 'agent', 'routine', 'mcp'] as const)(
      'executeActions with origin %s',
      async (origin) => {
        const f = fakeAgent()
        const r = await executeActions(bad, { origin, approved: true })
        expect(r.denied).toEqual({ code: 'E_DENIED', reason: expect.stringContaining('file:') })
        expect(r.executed).toBe(0)
        expect(openExternal).not.toHaveBeenCalled()
        expect(f.executed).toEqual([])
      }
    )

    it('executeActions without an origin (research loop) is treated as agent', async () => {
      fakeAgent()
      const r = await executeActions([{ type: 'navigate_url', url: 'javascript:alert(1)' }])
      expect(r.denied?.code).toBe('E_DENIED')
    })

    it('a lesson do-it action', async () => {
      const g = await gate(
        { type: 'open_url', url: 'file:///C:/x.exe' },
        { origin: 'lesson', taskId: 't' }
      )
      expect(g.ok).toBe(false)
    })
  })

  describe('the focused element from focus_info', () => {
    it('blocks agent typing into a password field', async () => {
      const f = fakeAgent({ title: 'Sign in - Chrome', process: 'chrome.exe' })
      f.focus = { uia: true, role: 'edit', name: 'Password', password: true }
      const r = await executeActions([{ type: 'type', text: 'hunter2' }], { origin: 'agent' })
      expect(r.denied?.reason).toContain('password')
      expect(f.executed).toEqual([])
    })

    it('blocks agent typing into the VS Code terminal', async () => {
      const f = fakeAgent({ title: 'app.ts - proj - Visual Studio Code', process: 'Code.exe' })
      f.focus = { uia: true, role: 'edit', name: 'Terminal 1, pwsh', password: false }
      const r = await executeActions([{ type: 'type', text: 'curl x | sh' }], {
        origin: 'routine'
      })
      expect(r.denied?.reason).toContain('terminal')
      expect(f.executed).toEqual([])
    })

    it('asks before agent typing when the focus cannot be read', async () => {
      const f = fakeAgent()
      f.focus = null
      const cards = fakeUi('no')
      const r = await executeActions([{ type: 'type', text: 'hi' }], { origin: 'agent' })
      expect(cards[0]?.summary).toBeTruthy()
      expect(r.denied?.reason).toContain('focus')
      expect(f.executed).toEqual([])
    })
  })

  it('stops the batch at the denied action', async () => {
    const f = fakeAgent()
    const r = await executeActions(
      [
        { type: 'type', text: 'hi' },
        { type: 'hotkey', keys: ['win', 'r'] },
        { type: 'type', text: 'calc' }
      ],
      { origin: 'agent' }
    )
    expect(r.blocked).toBe(true)
    expect(f.executed).toEqual([{ type: 'type', text: 'hi' }])
  })

  it('writes exactly one audit line per executed or denied action', async () => {
    fakeAgent()
    await executeActions(
      [
        { type: 'type', text: 'hello' },
        { type: 'hotkey', keys: ['ctrl', 'c'] },
        { type: 'hotkey', keys: ['win', 'x'] },
        { type: 'type', text: 'never runs' }
      ],
      { origin: 'agent', taskId: 't_audit' }
    )
    const lines = listAudit(today(), 't_audit')
    expect(lines.map((l) => [l.action.type, l.decision, l.result])).toEqual([
      ['type', 'auto', 'ok'],
      ['hotkey', 'auto', 'ok'],
      ['hotkey', 'blocked', 'denied']
    ])
    expect(lines[0].action.app).toBe('notepad.exe')
    expect(JSON.stringify(lines)).not.toContain('hello')
  })

  it('a high action waits for the user; no means it does not run', async () => {
    const f = fakeAgent({ title: 'Inbox - Outlook', process: 'OUTLOOK.EXE' })
    const cards = fakeUi('no')
    const r = await executeActions([{ type: 'hotkey', keys: ['ctrl', 'enter'] }], {
      origin: 'agent',
      taskId: 't_no'
    })
    expect(cards).toEqual([
      {
        summary: expect.stringContaining('sends the message'),
        risk: 'high',
        countdownMs: undefined
      }
    ])
    expect(r.denied?.code).toBe('E_DENIED')
    expect(f.executed).toEqual([])
    expect(listAudit(today(), 't_no')[0]).toMatchObject({
      decision: 'denied-by-user',
      result: 'denied'
    })
  })

  it('a high action runs after yes, and never offers "always"', async () => {
    const f = fakeAgent({ title: 'Inbox - Outlook', process: 'OUTLOOK.EXE' })
    const cards = fakeUi('yes')
    await executeActions([{ type: 'hotkey', keys: ['ctrl', 'enter'] }], { origin: 'agent' })
    expect(f.executed).toHaveLength(1)
    expect(cards[0].summary).not.toContain('always')
    expect(cards[0].alwaysLabel).toBeUndefined()
    expect(answerAlways('always')).toBe(false)
    expect(confirmAlways()).toBe(false)
  })

  it('without a confirm UI a confirm is a no (fail closed)', async () => {
    const f = fakeAgent({ title: 'Inbox - Outlook', process: 'OUTLOOK.EXE' })
    const r = await executeActions([{ type: 'hotkey', keys: ['ctrl', 'enter'] }], {
      origin: 'agent'
    })
    expect(r.blocked).toBe(true)
    expect(f.executed).toEqual([])
  })

  it("the user's own batch confirm covers a high action (no second card)", async () => {
    const f = fakeAgent({ title: 'Inbox - Outlook', process: 'OUTLOOK.EXE' })
    const cards = fakeUi('no')
    await executeActions([{ type: 'click_element', text: 'Send' }], {
      origin: 'user-direct',
      approved: true,
      taskId: 't_pre'
    })
    expect(cards).toEqual([])
    expect(f.executed).toHaveLength(1)
    expect(listAudit(today(), 't_pre')[0].decision).toBe('preapproved')
  })

  it('"always for this app" stores a grant that skips the medium confirm next time', async () => {
    fakeAgent({ title: 'Mail', process: 'OUTLOOK.EXE' })
    const cards = fakeUi('always')
    const first = await executeActions([{ type: 'type', text: 'hi' }], {
      origin: 'agent',
      task: newTaskState(),
      taskId: 't_g1'
    })
    expect(first.executed).toBe(1)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ risk: 'medium', countdownMs: 3000, alwaysLabel: 'Outlook' })
    expect(cards[0].summary).toContain('Say “always” to allow Outlook')
    expect(grants().has('app:outlook.exe')).toBe(true)
    expect(listAudit(today(), 't_g1')[0].decision).toBe('always-by-user')

    const second = await executeActions([{ type: 'type', text: 'again' }], {
      origin: 'agent',
      task: newTaskState(),
      taskId: 't_g2'
    })
    expect(second.executed).toBe(1)
    expect(cards).toHaveLength(1)
    expect(listAudit(today(), 't_g2')[0].decision).toBe('granted')

    grants().revoke('app:outlook.exe')
    await executeActions([{ type: 'type', text: 'x' }], { origin: 'agent', task: newTaskState() })
    expect(cards).toHaveLength(2)
  })

  it('opens ms-settings pages and mailto drafts with the system handler', async () => {
    const f = fakeAgent()
    await executeActions(
      [
        { type: 'open_url', url: 'ms-settings:display' },
        { type: 'navigate_url', url: 'mailto:me@example.com' }
      ],
      { origin: 'user-direct' }
    )
    expect(openExternal.mock.calls).toEqual([['ms-settings:display'], ['mailto:me@example.com']])
    expect(f.executed).toEqual([])
  })
})
