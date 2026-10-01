// Email end to end with a scripted model and a fake agent (08 email): the agent runner's act and
// keys calls go through the real executor and policy gate, as in agent mode. A draft is written,
// the recipient shows on the confirm card, Send never runs without a yes, and an address the user
// never said is not typed when the card is declined.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  screen: {
    getPrimaryDisplay: () => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    }),
    dipToScreenPoint: (p: unknown) => p,
    screenToDipPoint: (p: unknown) => p,
    screenToDipRect: (_w: unknown, r: unknown) => r
  }
}))
vi.mock('../../src/main/util', () => ({ sleep: async () => {} }))
vi.mock('../../src/main/ai/observe', () => ({
  waitForSettle: async () => ({ reason: 'timeout', ms: 0 })
}))
vi.mock('../../src/main/windows/highlight', () => ({ send: vi.fn(), show: vi.fn(), hide: vi.fn() }))
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn() }))
vi.mock('../../src/main/query/refine', () => ({
  needsRefine: () => false,
  canRefine: () => false,
  refineTarget: vi.fn()
}))

import type { Action } from '@shared/types'
import { executeActions } from '../../src/main/actions/executor'
import type { AgentBridge } from '../../src/main/agent/bridge'
import { setAgent } from '../../src/main/agent/instance'
import { setConfirmUi, type ConfirmCard } from '../../src/main/agent-mode/confirm'
import { installGrants } from '../../src/main/agent-mode/grants'
import {
  runAgent,
  type RunnerDeps,
  type ToolHandler,
  type ToolOutcome
} from '../../src/main/agent-mode/runner'
import { FOREGROUND_TOOLS } from '../../src/main/agent-mode/tools'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import { installAudit, uninstallAudit } from '../../src/main/audit/log'
import { setConfigDir } from '../../src/main/config'
import { tempDir } from '../helpers/fixtures'

interface Element {
  name: string
  role: string
}

/** A mail window: its elements by id, what has focus, and every uia_act / input that ran. */
interface FakeMail {
  window: { title: string; process: string }
  elements: Record<string, Element>
  focus: string | null
  ran: { cmd: string; args: Record<string, unknown> }[]
}

function fakeMail(window: FakeMail['window'], elements: Record<string, Element>): FakeMail {
  const f: FakeMail = { window, elements, focus: null, ran: [] }
  setAgent({
    hasCapability: () => false,
    activeWindow: async () => f.window.title,
    execute: async (a: Record<string, unknown>) => {
      f.ran.push({ cmd: 'execute', args: a })
      return null
    },
    request: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'active_window') return f.window
      if (cmd === 'focus_info') {
        const el = f.focus ? f.elements[f.focus] : null
        return {
          ...f.window,
          uia: true,
          password: false,
          name: el?.name ?? '',
          role: el?.role ?? ''
        }
      }
      if (cmd === 'uia_act' || cmd === 'input') {
        f.ran.push({ cmd, args })
        if (cmd === 'uia_act' && typeof args.elementId === 'string') f.focus = args.elementId
      }
      return {}
    }
  } as unknown as AgentBridge)
  return f
}

/** Confirm UI: `answer(card)` decides; every card is kept. */
function confirmUi(answer: (card: ConfirmCard) => boolean): ConfirmCard[] {
  const cards: ConfirmCard[] = []
  setConfirmUi({
    ask: async (card) => {
      cards.push(card)
      return answer(card)
    },
    confirm: () => {}
  })
  return cards
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
let seq = 0
const call = (name: string, input: Record<string, unknown>): ToolCall => ({
  id: `c${++seq}`,
  name,
  input
})
const reply = (c: ToolCall): ToolTurnResult => ({
  message: { role: 'assistant', text: '', calls: [c] },
  usage,
  model: 'fake',
  stopReason: 'tool_use'
})

/** The act / keys handlers as agent mode wires them: model call → Action → executeActions. */
function handlersFor(f: FakeMail, userText: string): Record<string, ToolHandler> {
  const exec = async (actions: Action[]): Promise<ToolOutcome> => {
    const r = await executeActions(actions, {
      origin: 'agent',
      userText,
      preview: false,
      refine: false,
      pauseMs: 0
    })
    return r.denied
      ? {
          content: [{ type: 'text' as const, text: `Not done: ${r.denied.reason}` }],
          isError: true
        }
      : { content: [{ type: 'text' as const, text: 'ok' }], actions: r.executed }
  }
  return {
    observe: async () => ({ content: [{ type: 'text', text: 'screen' }] }),
    act: async (input) => {
      const ref = String((input.target as { ref?: string } | undefined)?.ref ?? '')
      const el = f.elements[ref]
      const op = String(input.op)
      if (op === 'type') return exec([{ type: 'type', text: String(input.value ?? '') }])
      return exec([
        {
          type: 'uia_act',
          elementId: ref,
          action: op === 'set_value' ? 'set_value' : 'invoke',
          ...(input.value !== undefined ? { value: String(input.value) } : {}),
          description: el?.name ?? ''
        }
      ])
    },
    keys: async (input) => exec([{ type: 'hotkey', keys: String(input.combo).split('+') }])
  }
}

function deps(script: ToolTurnResult[], handlers: Record<string, ToolHandler>): RunnerDeps {
  let i = 0
  return {
    model: {
      plan: async () => ({
        plan: {
          summary: 'write the email',
          steps: ['Open a new email', 'Fill it in'],
          risk: 'low'
        },
        model: 'fake',
        usage
      }),
      turn: async () => script[Math.min(i++, script.length - 1)]
    },
    handlers,
    publish: () => {},
    speak: () => {},
    countdown: async () => 'elapsed',
    askContinue: async () => false,
    costOf: () => 0,
    now: () => Date.now()
  }
}

const GMAIL = {
  title: 'Inbox (3) - jip@example.com - Gmail - Google Chrome',
  process: 'chrome.exe'
}
const GMAIL_COMPOSE: Record<string, Element> = {
  e2: { name: 'Compose', role: 'button' },
  e12: { name: 'To recipients', role: 'combobox' },
  e14: { name: 'Subject', role: 'edit' },
  e15: { name: 'Message Body', role: 'edit' },
  e16: { name: 'Send (Ctrl-Enter)', role: 'button' }
}
const ranOn = (f: FakeMail, id: string): FakeMail['ran'] =>
  f.ran.filter((r) => r.cmd === 'uia_act' && r.args.elementId === id)

describe('email flow (scripted model, real policy gate)', () => {
  let tmp: ReturnType<typeof tempDir>
  beforeEach(() => {
    tmp = tempDir()
    setConfigDir(tmp.dir)
    installGrants(`${tmp.dir}/grants.json`)
    installAudit(`${tmp.dir}/audit`)
  })
  afterEach(() => {
    setAgent(null)
    setConfirmUi(null)
    uninstallAudit()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('"write an email to Anna": a draft, the recipient on the card, Send never runs on a no', async () => {
    const userText = 'write an email to Anna about lunch on Friday'
    const f = fakeMail(GMAIL, GMAIL_COMPOSE)
    // Yes to everything except Send.
    const cards = confirmUi((card) => !/send/i.test(card.summary))
    const script = [
      reply(call('act', { op: 'invoke', target: { kind: 'element', ref: 'e2' } })),
      reply(
        call('act', { op: 'set_value', target: { kind: 'element', ref: 'e12' }, value: 'Anna' })
      ),
      reply(
        call('act', {
          op: 'set_value',
          target: { kind: 'element', ref: 'e14' },
          value: 'Lunch on Friday'
        })
      ),
      reply(
        call('act', {
          op: 'set_value',
          target: { kind: 'element', ref: 'e15' },
          value: 'Hi Anna, are you free for lunch on Friday? Jan'
        })
      ),
      reply(call('act', { op: 'invoke', target: { kind: 'element', ref: 'e16' } })),
      reply(
        call('finish', {
          summary: 'The email to Anna is ready.',
          needsUserAction: 'Check the email and press Send'
        })
      )
    ]
    const r = await runAgent(
      {
        prompt: userText,
        context: { window: GMAIL.title, now: new Date(0) },
        tools: FOREGROUND_TOOLS,
        cancelWindowMs: 0
      },
      deps(script, handlersFor(f, userText))
    )
    expect(r.status).toBe('done')
    expect(r.needsUserAction).toBe('Check the email and press Send')
    // The recipient was on a card (medium: countdown) and was filled.
    const toCard = cards.find((c) => c.summary.includes('fills the recipient “Anna”'))
    expect(toCard?.risk).toBe('medium')
    expect(ranOn(f, 'e12')).toHaveLength(1)
    // Subject and body went in.
    expect(ranOn(f, 'e14')).toHaveLength(1)
    expect(ranOn(f, 'e15')).toHaveLength(1)
    // Send asked, high, and did not run.
    const sendCard = cards.find((c) => c.summary.includes('send'))
    expect(sendCard).toMatchObject({ risk: 'high' })
    expect(sendCard?.countdownMs).toBeUndefined()
    expect(ranOn(f, 'e16')).toHaveLength(0)
  })

  it('Send without a confirm UI (nobody to ask) never runs', async () => {
    const f = fakeMail(GMAIL, GMAIL_COMPOSE)
    const r = await executeActions(
      [{ type: 'uia_act', elementId: 'e16', action: 'invoke', description: 'Send (Ctrl-Enter)' }],
      { origin: 'agent', userText: 'send it', preview: false, refine: false, pauseMs: 0 }
    )
    expect(r.denied?.reason).toContain('send')
    expect(ranOn(f, 'e16')).toHaveLength(0)
  })

  it('Ctrl+Enter in the body asks too, and runs only on a yes', async () => {
    const f = fakeMail(GMAIL, GMAIL_COMPOSE)
    f.focus = 'e15'
    const cards = confirmUi(() => false)
    const opts = {
      origin: 'agent' as const,
      userText: 'send it',
      preview: false,
      refine: false,
      pauseMs: 0
    }
    const no = await executeActions([{ type: 'hotkey', keys: ['ctrl', 'enter'] }], opts)
    expect(no.denied?.reason).toBe('sends the message')
    expect(cards[0].risk).toBe('high')
    expect(f.ran.filter((x) => x.cmd === 'execute')).toHaveLength(0)
    confirmUi(() => true)
    const yes = await executeActions([{ type: 'hotkey', keys: ['ctrl', 'enter'] }], opts)
    expect(yes.executed).toBe(1)
  })

  it('a wrong recipient is never filled in silently: high card, nothing typed on a no', async () => {
    const userText = 'email Anna that I am running late'
    const f = fakeMail(GMAIL, GMAIL_COMPOSE)
    const cards = confirmUi(() => false)
    const script = [
      reply(call('act', { op: 'invoke', target: { kind: 'element', ref: 'e2' } })),
      reply(
        call('act', {
          op: 'set_value',
          target: { kind: 'element', ref: 'e12' },
          value: 'anna.berg@acme-corp.example'
        })
      ),
      reply(call('finish', { summary: 'I need you to pick Anna’s address.' }))
    ]
    await runAgent(
      {
        prompt: userText,
        context: { window: GMAIL.title, now: new Date(0) },
        tools: FOREGROUND_TOOLS,
        cancelWindowMs: 0
      },
      deps(script, handlersFor(f, userText))
    )
    const card = cards.find((c) => c.summary.includes('anna.berg@acme-corp.example'))
    expect(card?.risk).toBe('high')
    expect(card?.summary).toContain('did not name')
    expect(ranOn(f, 'e12')).toHaveLength(0)
  })

  it('classic Outlook: Alt+S is a send; delete on the list asks', async () => {
    const f = fakeMail(
      { title: 'Inbox - jan@example.com - Outlook', process: 'OUTLOOK.EXE' },
      { e11: { name: 'From Anna Berg Subject Lunch on Friday', role: 'dataitem' } }
    )
    f.focus = 'e11'
    const cards = confirmUi(() => false)
    const opts = {
      origin: 'agent' as const,
      userText: 'tidy my inbox',
      preview: false,
      refine: false,
      pauseMs: 0
    }
    expect(
      (await executeActions([{ type: 'hotkey', keys: ['delete'] }], opts)).denied?.reason
    ).toBe('deletes the email')
    expect(
      (await executeActions([{ type: 'hotkey', keys: ['alt', 's'] }], opts)).denied?.reason
    ).toBe('sends the email')
    expect(cards.map((c) => c.risk)).toEqual(['high', 'high'])
    expect(f.ran.filter((x) => x.cmd === 'execute')).toHaveLength(0)
  })

  it('new Outlook: the To box picks a suggestion with Enter without a send card', async () => {
    const f = fakeMail(
      { title: 'Mail - Jan Om - Outlook', process: 'olk.exe' },
      { e4: { name: 'To', role: 'edit' } }
    )
    f.focus = 'e4'
    const cards = confirmUi(() => true)
    const r = await executeActions(
      [
        { type: 'type', text: 'Mark' },
        { type: 'hotkey', keys: ['enter'] }
      ],
      {
        origin: 'agent',
        userText: 'forward this to Mark',
        preview: false,
        refine: false,
        pauseMs: 0
      }
    )
    expect(r.executed).toBe(2)
    expect(cards.map((c) => c.summary).join(' ')).not.toContain('sends the message')
    expect(cards[0].summary).toContain('fills the recipient “Mark”')
  })
})
