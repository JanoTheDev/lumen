// Foreground skill runs (11 T04) with the app wiring faked: steps.json runs with no model call
// through the input lane, permissions block and are announced, cancel stops mid-run.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Action, ElementNode, SkillManifest } from '@shared/types'

const h = vi.hoisted(() => ({
  steps: null as unknown,
  executed: [] as Action[][],
  audit: [] as Record<string, unknown>[],
  runs: [] as unknown[],
  confirm: 'once' as 'once' | 'deny',
  process: 'gimp-2.10.exe',
  onExecute: null as null | ((a: Action[]) => void)
}))

vi.mock('../../src/main/actions/executor', () => ({
  executeActions: vi.fn(async (actions: Action[]) => {
    h.executed.push(actions)
    h.onExecute?.(actions)
    return {
      executed: actions.length,
      cancelled: false,
      blocked: false,
      reachedBottom: false,
      targets: [],
      maxRisk: 'low'
    }
  })
}))
vi.mock('../../src/main/agent/instance', () => ({ requireAgent: () => ({}) }))
vi.mock('../../src/main/agent/commands', () => ({
  activeWindow: async () => ({ title: 'GIMP', process: h.process }),
  uiaSnapshot: async () => ({
    root: {
      id: 'root',
      name: '',
      role: 'window',
      rect: { x: 0, y: 0, w: 100, h: 100 },
      monitorId: 0,
      enabled: true,
      patterns: [],
      children: [
        node('e1', 'Export As…', 'menuitem', ['invoke']),
        node('e2', 'File name', 'edit', ['value'])
      ]
    }
  })
}))
vi.mock('../../src/main/audit/log', () => ({
  writeAudit: (e: Record<string, unknown>) => h.audit.push(e)
}))
vi.mock('../../src/main/skills', () => ({
  getSkillRegistry: () => null,
  loadSkillSteps: () => h.steps,
  recordSkillRun: (_n: string, r: unknown) => h.runs.push(r)
}))
vi.mock('../../src/main/agent-mode/confirm', () => ({ askUser: vi.fn(async () => h.confirm) }))
vi.mock('../../src/main/ai/skills', () => ({
  matchSkill: () => null,
  appNameOf: (p?: string) => p?.replace(/\.exe$/i, '')
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/agent-mode/handlers', () => ({ waitProbe: {} }))
vi.mock('../../src/main/agent-mode/wait-for', () => ({
  waitFor: async () => ({ ok: true, ms: 5, detail: 'seen' })
}))

function node(id: string, name: string, role: string, patterns: string[]): ElementNode {
  return {
    id,
    name,
    role,
    rect: { x: 10, y: 10, w: 20, h: 20 },
    monitorId: 0,
    enabled: true,
    patterns: patterns as ElementNode['patterns']
  }
}

import { inputLane, setInputLane } from '../../src/main/agent-mode/input-lane'
import { runStepsForeground, skillGuard, type SkillHost } from '../../src/main/agent-mode/skill-run'
import type { TaskEnv } from '../../src/main/agent-mode/handlers'
import { newTaskState } from '../../src/main/actions/safety'
import { permissionsSchema } from '../../src/main/skills/manifest'
import type { LoadedSkill } from '../../src/main/skills/registry'
import { askUser as askConfirm } from '../../src/main/agent-mode/confirm'

function skill(perms: Record<string, unknown>, extra: Partial<SkillManifest> = {}): LoadedSkill {
  return {
    manifest: {
      name: 'export-png',
      description: 'Export as PNG.',
      version: '1.0.0',
      apps: ['gimp'],
      triggers: [],
      params: { file: { type: 'string' } },
      permissions: permissionsSchema.parse(perms),
      context: 'foreground',
      ...extra
    },
    dir: '/skills/export-png',
    origin: 'user',
    baseTrust: 'mine',
    hasSteps: true,
    warnings: []
  }
}

const env = (): TaskEnv => ({
  taskId: 't_skill',
  prompt: 'export png',
  state: newTaskState(),
  fields: { typed: new Map() },
  observedText: '',
  ask: { speak: () => {}, listen: () => {} }
})

let host: SkillHost & { said: string[]; phases: string[] }

beforeEach(() => {
  h.executed = []
  h.audit = []
  h.runs = []
  h.confirm = 'once'
  h.process = 'gimp-2.10.exe'
  h.onExecute = null
  h.steps = {
    version: 1,
    steps: [
      { do: 'invoke', target: { name: 'Export As…' } },
      { do: 'set_value', target: { name: 'File name' }, value: '{file}.png' },
      { do: 'keys', combo: 'enter' }
    ]
  }
  setInputLane(null)
  const said: string[] = []
  const phases: string[] = []
  host = {
    said,
    phases,
    speak: (t) => said.push(t),
    publish: (t) => phases.push(t.phase),
    ask: { speak: () => {}, listen: () => {} }
  }
})

describe('skill steps in the foreground', () => {
  it('runs offline with the given values, holding the input lane', async () => {
    let holder: string | null = null
    h.onExecute = () => (holder = inputLane().holderName())
    const r = await runStepsForeground(
      skill({ input: true }),
      env(),
      [{ name: 'file', value: 'cat' }],
      host,
      new AbortController().signal
    )
    expect(r.kind).toBe('outcome')
    if (r.kind === 'outcome') expect(r.outcome).toEqual({ status: 'done', ran: 3, actions: 3 })
    expect(holder).toBe('t_skill')
    expect(inputLane().holderName()).toBeNull()
    expect(h.executed[1]).toEqual([
      {
        type: 'uia_act',
        elementId: 'e2',
        action: 'set_value',
        value: 'cat.png',
        description: 'File name'
      }
    ])
    expect(host.phases.at(-1)).toBe('done')
  })

  it('blocks a skill without input permission and says why', async () => {
    const r = await runStepsForeground(
      skill({ input: false }),
      env(),
      [{ name: 'file', value: 'cat' }],
      host,
      new AbortController().signal
    )
    expect(r.kind === 'outcome' && r.outcome.status).toBe('denied')
    expect(h.executed).toEqual([])
    expect(host.said).toEqual([
      'The export png skill is not allowed to use the mouse and keyboard, so I blocked that.'
    ])
    expect(h.audit[0]).toMatchObject({ decision: 'blocked', result: 'denied', task: 't_skill' })
  })

  it('blocks input outside the skill apps', async () => {
    h.process = 'outlook.exe'
    const r = await runStepsForeground(
      skill({ input: true }),
      env(),
      [{ name: 'file', value: 'cat' }],
      host,
      new AbortController().signal
    )
    expect(r.kind === 'outcome' && r.outcome.status).toBe('denied')
    expect(host.said[0]).toMatch(/in outlook \(only in gimp\)/)
  })

  it('stops mid-run on cancel and frees the lane', async () => {
    const ac = new AbortController()
    h.onExecute = (a) => {
      if (a[0].type === 'uia_act' && (a[0] as { action: string }).action === 'invoke')
        ac.abort(new Error('stopped'))
    }
    await expect(
      runStepsForeground(
        skill({ input: true }),
        env(),
        [{ name: 'file', value: 'x' }],
        host,
        ac.signal
      )
    ).rejects.toThrow('stopped')
    expect(h.executed).toHaveLength(1)
    expect(inputLane().holderName()).toBeNull()
    expect(host.phases.at(-1)).toBe('aborted')
  })

  it('hands broken steps to the model', async () => {
    h.steps = null
    expect(
      await runStepsForeground(
        skill({ input: true }),
        env(),
        [],
        host,
        new AbortController().signal
      )
    ).toEqual({ kind: 'none' })
  })
})

describe('skill guard on agent tool calls', () => {
  it('denies, audits and speaks once', async () => {
    const guard = skillGuard(skill({ input: false }), env(), host)
    const signal = new AbortController().signal
    const a = await guard('act', { op: 'click' }, signal)
    const b = await guard('keys', { combo: 'ctrl+s' }, signal)
    expect(a?.isError).toBe(true)
    expect((a?.content[0] as { text: string }).text).toMatch(/^E_DENIED/)
    expect(b?.isError).toBe(true)
    expect(host.said).toHaveLength(1)
    expect(h.audit).toHaveLength(2)
    expect(await guard('observe', { what: 'screen' }, signal)).toBeNull()
  })

  it('asks before every action for a risky skill', async () => {
    const guard = skillGuard(skill({ input: true, risky: true }), env(), host)
    const signal = new AbortController().signal
    expect(await guard('act', { op: 'click', target: { ref: 'OK' } }, signal)).toBeNull()
    h.confirm = 'deny'
    const r = await guard('act', { op: 'click' }, signal)
    expect((r?.content[0] as { text: string }).text).toMatch(/user said no/)
    expect(askConfirm).toHaveBeenCalledTimes(2)
  })

  it('asks through the host when it has its own confirm (background: the Tasks list)', async () => {
    const asked: string[] = []
    const queued = {
      speak: () => {},
      confirm: async (text: string) => (asked.push(text), false)
    }
    vi.mocked(askConfirm).mockClear()
    const guard = skillGuard(skill({ risky: true, connectors: ['github'] }), env(), queued)
    const r = await guard('mcp__github__search', { q: 'x' }, new AbortController().signal)
    expect(r?.isError).toBe(true)
    expect(asked).toEqual(['export-png: Use github: search'])
    expect(askConfirm).not.toHaveBeenCalled()
  })
})
