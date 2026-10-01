// The deterministic path of the skill runner (11 T04): runs without any model, verifies each
// step, stops on drift / denial, and cancels mid-run.
import { describe, expect, it, vi } from 'vitest'
import type { Action, ElementNode } from '@shared/types'
import {
  driftNote,
  runSkillSteps,
  type StepPorts,
  type StepsOutcome
} from '../../src/main/skills/step-runner'
import type { SkillStep } from '../../src/main/skills/steps'

const el = (id: string, name: string, role = 'button'): ElementNode => ({
  id,
  name,
  role,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  monitorId: 0,
  enabled: true,
  patterns: ['invoke', 'value']
})

function ports(over: Partial<StepPorts> = {}): StepPorts & { ran: Action[][]; clock: number } {
  const p = {
    ran: [] as Action[][],
    clock: 0,
    elements: async () => [
      el('e1', 'File', 'menuitem'),
      el('e2', 'Export As'),
      el('e3', 'Name', 'edit')
    ],
    execute: async (actions: Action[]) => {
      p.ran.push(actions)
      return { executed: actions.length }
    },
    waitFor: async () => ({ ok: true, detail: 'seen' }),
    sleep: async (ms: number) => {
      p.clock += ms
    },
    now: () => p.clock,
    ...over
  }
  return p
}

const STEPS: SkillStep[] = [
  { do: 'invoke', target: { name: 'File', role: 'menuitem' } },
  {
    do: 'invoke',
    target: { name: 'Export As' },
    expect: { kind: 'window_title', value: 'Export' }
  },
  { do: 'set_value', target: { name: 'Name' }, value: 'photo.png' },
  { do: 'keys', combo: 'enter' }
]

const signal = (): AbortSignal => new AbortController().signal

describe('runSkillSteps', () => {
  it('runs every step offline and verifies the expected result', async () => {
    const p = ports()
    const waitFor = vi.spyOn(p, 'waitFor')
    const progress = vi.fn()
    const r = await runSkillSteps(STEPS, { ...p, progress }, signal())
    expect(r).toEqual({ status: 'done', ran: 4, actions: 4 })
    expect(p.ran.map((a) => a[0].type)).toEqual(['uia_act', 'uia_act', 'uia_act', 'hotkey'])
    expect(waitFor).toHaveBeenCalledWith(
      { kind: 'window_title', value: 'Export' },
      5000,
      expect.anything()
    )
    expect(progress).toHaveBeenCalledTimes(4)
  })

  it('waits for a target that appears late', async () => {
    let calls = 0
    const p = ports({
      elements: async () => (++calls < 3 ? [] : [el('e1', 'File', 'menuitem')])
    })
    const r = await runSkillSteps([STEPS[0]], p, signal())
    expect(r.status).toBe('done')
    expect(calls).toBe(3)
  })

  it('stops with drift when a target never appears', async () => {
    const p = ports({ elements: async () => [el('e1', 'File', 'menuitem')] })
    const r = await runSkillSteps(STEPS, p, signal())
    expect(r).toMatchObject({ status: 'drift', at: 1, ran: 1 })
    expect((r as { reason: string }).reason).toMatch(/Export As/)
    expect(p.ran).toHaveLength(1)
  })

  it('stops with drift when the check after a step fails', async () => {
    const p = ports({ waitFor: async () => ({ ok: false, detail: 'title was "Untitled"' }) })
    const r = await runSkillSteps(STEPS, p, signal())
    expect(r).toMatchObject({ status: 'drift', at: 1 })
    expect((r as { reason: string }).reason).toMatch(/check failed/)
  })

  it('ends on a permission refusal without running the step', async () => {
    const p = ports({
      permit: async (s) => (s.do === 'keys' ? 'E_DENIED: not allowed to press keys' : null)
    })
    const r = await runSkillSteps(STEPS, p, signal())
    expect(r).toMatchObject({
      status: 'denied',
      at: 3,
      reason: 'E_DENIED: not allowed to press keys'
    })
    expect(p.ran).toHaveLength(3)
  })

  it('ends when the safety policy denies an action', async () => {
    const p = ports({ execute: async () => ({ executed: 0, denied: 'E_DENIED: blocked' }) })
    const r = await runSkillSteps(STEPS, p, signal())
    expect(r).toMatchObject({ status: 'denied', at: 0, reason: 'E_DENIED: blocked' })
  })

  it('cancels mid-run', async () => {
    const ac = new AbortController()
    const p = ports({
      execute: async (actions) => {
        if (
          actions[0].type === 'uia_act' &&
          (actions[0] as { action: string }).action === 'set_value'
        )
          ac.abort(new Error('cancelled by user'))
        return { executed: actions.length }
      }
    })
    await expect(runSkillSteps(STEPS, p, ac.signal)).rejects.toThrow('cancelled by user')
  })

  it('writes a drift note for the model', () => {
    const outcome = { status: 'drift', at: 1, ran: 1, actions: 1, reason: 'gone' } as Extract<
      StepsOutcome,
      { status: 'drift' }
    >
    const note = driftNote(STEPS, outcome)
    expect(note).toMatch(/Already done: 1\. Click “File”/)
    expect(note).toMatch(/Went off at step 2: gone/)
    expect(note).toMatch(/4\. Press enter/)
  })
})
