import { describe, expect, it } from 'vitest'
import type { Action, ElementNode, Point } from '@shared/types'
import type { ExecuteResult } from '../../src/main/actions/executor'
import { evaluate, newTaskState } from '../../src/main/actions/safety'
import {
  nameAtTarget,
  performAct,
  type StrategyPorts,
  type TypedFields
} from '../../src/main/agent-mode/exec-strategy'

const node = (over: Partial<ElementNode>): ElementNode => ({
  id: 'e1',
  role: 'button',
  name: 'Dark',
  rect: { x: 100, y: 200, w: 40, h: 20 },
  monitorId: 1,
  enabled: true,
  patterns: [],
  ...over
})

interface Fake {
  ports: StrategyPorts
  batches: Action[][]
  buddy: { to: Point | null; mode: string }[]
  restored: Point[]
  pointer: Point
  value: string | null
}

function fake(elements: ElementNode[], over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    batches: [],
    buddy: [],
    restored: [],
    pointer: { x: 5, y: 5 },
    value: null,
    ports: {} as StrategyPorts,
    ...over
  }
  f.ports = {
    element: (id) => elements.find((e) => e.id === id),
    readValue: async () => f.value,
    execute: async (actions): Promise<ExecuteResult> => {
      f.batches.push(actions)
      const targets = actions
        .filter((a) => a.type === 'click_target')
        .map(() => ({ x: 100, y: 200, w: 40, h: 20 }))
      // A real click leaves the pointer on the target.
      if (targets.length) f.pointer = { x: 120, y: 210 }
      return {
        executed: actions.length,
        cancelled: false,
        blocked: false,
        reachedBottom: false,
        targets,
        maxRisk: 'low'
      }
    },
    buddy: (to, mode) => f.buddy.push({ to, mode }),
    physToLogical: (p) => p,
    pointer: () => f.pointer,
    restorePointer: async (p) => {
      f.restored.push(p)
      f.pointer = p
    },
    sleep: async () => {}
  }
  return f
}

const signal = new AbortController().signal
const fields = (): TypedFields => ({ typed: new Map() })

describe('ghost cursor strategy', () => {
  it('toggles through UIA without touching the pointer (Settings dark mode)', async () => {
    const f = fake([node({ role: 'radio button', patterns: ['toggle', 'select'] })])
    const r = await performAct(
      { op: 'toggle', target: { kind: 'element', ref: 'e1' } },
      f.ports,
      fields(),
      signal
    )
    expect(r).toMatchObject({ ok: true, ghost: true })
    expect(f.batches).toEqual([
      [{ type: 'uia_act', elementId: 'e1', action: 'toggle', description: 'Dark' }]
    ])
    expect(f.buddy).toEqual([{ to: { x: 120, y: 210 }, mode: 'point' }])
    expect(f.pointer).toEqual({ x: 5, y: 5 })
  })

  it('falls back to a real click, buddy first, then restores the pointer', async () => {
    const f = fake([node({ patterns: [] })])
    const r = await performAct(
      { op: 'invoke', target: { kind: 'element', ref: 'e1' } },
      f.ports,
      fields(),
      signal
    )
    expect(r).toMatchObject({ ok: true, ghost: false })
    expect(f.buddy[0].mode).toBe('fly')
    expect(f.batches[0][0]).toMatchObject({
      type: 'click_target',
      target: { kind: 'element', id: 'e1' }
    })
    expect(f.restored).toEqual([{ x: 5, y: 5 }])
  })

  it('does not restore the pointer when the user moved it', async () => {
    const f = fake([])
    f.ports.execute = async (actions) => {
      f.pointer = { x: 900, y: 900 } // the user grabbed the mouse
      return {
        executed: 1,
        cancelled: false,
        blocked: false,
        reachedBottom: false,
        targets: [{ x: 100, y: 200, w: 40, h: 20 }],
        maxRisk: 'low',
        ...{ actions }
      }
    }
    await performAct(
      { op: 'click', target: { kind: 'text', ref: 'Compose' } },
      f.ports,
      fields(),
      signal
    )
    expect(f.restored).toEqual([])
  })

  it('set_value uses ValuePattern on plain fields', async () => {
    const f = fake([node({ id: 'e2', role: 'edit', name: 'Subject', patterns: ['value'] })])
    await performAct(
      { op: 'set_value', target: { kind: 'element', ref: 'e2' }, value: 'Friday' },
      f.ports,
      fields(),
      signal
    )
    expect(f.batches).toEqual([
      [
        {
          type: 'uia_act',
          elementId: 'e2',
          action: 'set_value',
          value: 'Friday',
          description: 'Subject'
        }
      ]
    ])
  })

  it('rich text gets focus + typing instead of set_value', async () => {
    const f = fake([node({ id: 'e3', role: 'document', name: 'Body', patterns: ['value'] })])
    await performAct(
      { op: 'type', target: { kind: 'element', ref: 'e3' }, value: 'Hi Sam' },
      f.ports,
      fields(),
      signal
    )
    expect(f.batches).toEqual([
      [{ type: 'uia_act', elementId: 'e3', action: 'focus', description: 'Body' }],
      [{ type: 'type', text: 'Hi Sam' }]
    ])
  })

  it('retry-type guard: text already there is not typed again', async () => {
    const el = node({ id: 'e3', role: 'document', name: 'Body' })
    const f = fake([el])
    const typed = fields()
    const input = {
      op: 'type' as const,
      target: { kind: 'element' as const, ref: 'e3' },
      value: 'Hi Sam'
    }
    await performAct(input, f.ports, typed, signal)
    f.batches.length = 0
    f.value = 'Hi Sam'
    const r = await performAct(input, f.ports, typed, signal)
    expect(r.ok).toBe(true)
    expect(r.actions).toBe(0)
    expect(f.batches).toEqual([])
  })

  it('retry-type guard: partial text is selected and retyped', async () => {
    const f = fake([node({ id: 'e3', role: 'document', name: 'Body' })])
    const typed = fields()
    const input = {
      op: 'type' as const,
      target: { kind: 'element' as const, ref: 'e3' },
      value: 'Hi Sam'
    }
    await performAct(input, f.ports, typed, signal)
    f.batches.length = 0
    f.value = 'Hi S'
    await performAct(input, f.ports, typed, signal)
    expect(f.batches[1]).toEqual([
      { type: 'hotkey', keys: ['ctrl', 'a'] },
      { type: 'type', text: 'Hi Sam' }
    ])
  })

  it('retry-type guard: an unreadable field is not retyped blindly', async () => {
    const f = fake([node({ id: 'e3', role: 'document', name: 'Body' })])
    const typed = fields()
    const input = {
      op: 'type' as const,
      target: { kind: 'element' as const, ref: 'e3' },
      value: 'Hi'
    }
    await performAct(input, f.ports, typed, signal)
    f.batches.length = 0
    const r = await performAct(input, f.ports, typed, signal)
    expect(r.ok).toBe(false)
    expect(f.batches).toEqual([])
  })

  it('reports stale element ids and policy denials', async () => {
    const f = fake([])
    const stale = await performAct(
      { op: 'invoke', target: { kind: 'element', ref: 'e9' } },
      f.ports,
      fields(),
      signal
    )
    expect(stale.message).toContain('observe')
    f.ports.execute = async () => ({
      executed: 0,
      cancelled: false,
      blocked: true,
      denied: { code: 'E_DENIED', reason: 'blocked scheme' },
      reachedBottom: false,
      targets: [],
      maxRisk: 'low'
    })
    const denied = await performAct(
      { op: 'click', target: { kind: 'text', ref: 'Send' } },
      f.ports,
      fields(),
      signal
    )
    expect(denied.message).toMatch(/^E_DENIED: blocked scheme/)
  })

  it('scroll maps dx/dy to a direction', async () => {
    const f = fake([])
    await performAct({ op: 'scroll', dy: -3 }, f.ports, fields(), signal)
    expect(f.batches[0]).toEqual([{ type: 'scroll', direction: 'up', amount: 3 }])
  })
})

describe('click names for the policy (mark / point targets, double-click)', () => {
  const send = node({ id: 'e7', name: 'Send', rect: { x: 800, y: 600, w: 60, h: 30 } })
  const pane = node({ id: 'e8', name: 'Message', rect: { x: 0, y: 0, w: 1000, h: 1000 } })
  const marks = [{ n: 14, physRect: send.rect, label: '', elementId: 'e7' }]

  it('names a mark by its element, and a point by the smallest named element under it', () => {
    const src = { marks, elements: [pane, send], toPhys: (_f: string, p: Point) => p }
    expect(nameAtTarget({ kind: 'mark', n: 14 }, src)).toBe('Send')
    expect(nameAtTarget({ kind: 'point', x: 812, y: 610, frame: '1' }, src)).toBe('Send')
    expect(nameAtTarget({ kind: 'point', x: 5, y: 5, frame: '1' }, src)).toBe('Message')
    expect(nameAtTarget({ kind: 'mark', n: 99 }, src)).toBeUndefined()
    expect(
      nameAtTarget({ kind: 'point', x: 1, y: 1, frame: '2' }, { ...src, toPhys: () => null })
    ).toBeUndefined()
  })

  it('a mark click carries the resolved name, so "Send" is rated high', async () => {
    const f = fake([])
    f.ports.nameAt = () => 'Send'
    await performAct(
      { op: 'click', target: { kind: 'mark', ref: '14' } },
      f.ports,
      fields(),
      signal
    )
    const a = f.batches[0][0]
    expect(a).toMatchObject({ type: 'click_target', description: 'Send' })
    const d = evaluate(a, { origin: 'agent', task: newTaskState() })
    expect(d.risk).toBe('high')
  })

  it('a double-click carries the element name', async () => {
    const f = fake([node({ id: 'e2', name: 'setup.exe' })])
    await performAct(
      { op: 'double_click', target: { kind: 'element', ref: 'e2' } },
      f.ports,
      fields(),
      signal
    )
    const a = f.batches[0][0]
    expect(a).toMatchObject({ type: 'input', description: 'setup.exe' })
    const ctx = {
      origin: 'agent' as const,
      task: newTaskState(),
      activeWindow: { process: 'explorer.exe', title: 'Downloads' }
    }
    expect(evaluate(a, ctx).risk).toBe('high')
  })

  it('set_value on a password element carries the flag, and the policy blocks it', async () => {
    const f = fake([
      node({ id: 'e3', name: 'Password', role: 'edit', patterns: ['value'], password: true })
    ])
    await performAct(
      { op: 'set_value', target: { kind: 'element', ref: 'e3' }, value: 'hunter2' },
      f.ports,
      fields(),
      signal
    )
    const a = f.batches[0][0]
    expect(a).toMatchObject({ type: 'uia_act', action: 'set_value', password: true })
    expect(evaluate(a, { origin: 'agent', task: newTaskState() }).risk).toBe('blocked')
  })

  it('unnamed spot clicks in an agent task are medium and not grantable', () => {
    const ctx = { origin: 'agent' as const, task: newTaskState() }
    const d = evaluate({ type: 'click_target', target: { kind: 'point' } }, ctx)
    expect(d).toMatchObject({ risk: 'medium', needsConfirm: true })
    expect(d.grantScope).toBeUndefined()
    const dbl = {
      type: 'input',
      steps: [{ t: 'click' as const, button: 'left' as const, count: 2 }]
    }
    expect(evaluate(dbl, ctx).risk).toBe('medium')
    expect(
      evaluate({ type: 'click_target', target: { kind: 'point' } }, { origin: 'user-direct' }).risk
    ).toBe('low')
  })
})
