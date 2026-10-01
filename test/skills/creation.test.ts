import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/a11y', () => ({ announce: vi.fn() }))
vi.mock('../../src/main/a11y/dispatch', () => ({ LOCAL_HANDLED: { handled: true } }))
vi.mock('../../src/main/ai/providers', () => ({ getProvider: vi.fn() }))
vi.mock('../../src/main/skills/index', () => ({ getSkillRegistry: () => null }))

import type { ModelResponse } from '@shared/types'
import type { AuthoringText, SkillDraft } from '../../src/main/skills/authoring'
import {
  createSkillCreation,
  type CreationDeps,
  type SkillCreation
} from '../../src/main/skills/creation'

const HANDLED = { handled: true }

interface Setup {
  c: SkillCreation
  deps: CreationDeps
  saved: SkillDraft[]
  said: string[]
  tick(ms: number): number
  text(u: string): Promise<string>
}

function setup(words: AuthoringText | null = null): Setup {
  let now = 1_000_000
  const saved: SkillDraft[] = []
  const said: string[] = []
  const deps: CreationDeps = {
    now: () => now,
    words: vi.fn(async () => words),
    startRecording: vi.fn(() => ({ ok: true })),
    save: (d) => {
      saved.push(structuredClone(d))
      return { ok: true, name: d.name }
    },
    taken: (n) => n === 'morning',
    say: (t) => said.push(t),
    log: () => {},
    handled: HANDLED
  }
  const c = createSkillCreation(deps)
  return {
    c,
    deps,
    saved,
    said,
    tick: (ms: number) => (now += ms),
    text: async (u: string) => ((await c.intercept(u)) as ModelResponse & { text: string }).text
  }
}

describe('skill creation by voice', () => {
  it('drafts "when I say X, do Y", renames and saves on request', async () => {
    const t = setup()
    expect(await t.text('When I say morning, open my mail')).toMatch(
      /^Draft skill “morning 2”: Open my mail Say “save it”/
    )
    expect(await t.text('call it start my day')).toMatch(/Renamed it to “start my day”/)
    expect(await t.text('read it back')).toMatch(/Say “morning” to run it/)
    expect(await t.text('save it')).toMatch(/Saved the skill “start my day”\. Say “morning”/)
    expect(t.saved[0]).toMatchObject({ name: 'start-my-day', triggers: ['morning'] })
    // Nothing waits any more.
    expect(t.c.intercept('save it')).toBeUndefined()
  })

  it('takes a bare yes only shortly after the offer', async () => {
    const t = setup()
    await t.text('when I say hello, wave at me')
    t.tick(3 * 60_000)
    expect(t.c.intercept('yes')).toBeUndefined()
    expect(await t.text('discard it')).toBe('Draft skill discarded.')
    expect(t.saved).toEqual([])
  })

  it('saves the last run with the model words and its steps', async () => {
    const t = setup({
      name: 'mail-report',
      description: 'Mails the report.',
      triggers: ['mail the report'],
      instructions: '1. New mail to {to}.',
      params: [{ name: 'to', description: 'recipient', value: 'anna@example.com' }]
    })
    expect(await t.text('save that as a skill')).toMatch(/no finished task/)
    t.c.rememberRun({
      prompt: 'mail the report to anna',
      summary: 'Done.',
      at: 1_000_000,
      steps: [
        { tool: 'act', op: 'invoke', element: { name: 'New mail' } },
        { tool: 'act', op: 'type', element: { name: 'To' }, value: 'anna@example.com' }
      ]
    })
    expect(await t.text('save that as a skill')).toMatch(/Draft skill “mail report”/)
    expect(await t.text('save it as weekly report')).toMatch(/Saved the skill “weekly report”/)
    expect(t.saved[0].steps?.steps[1]).toMatchObject({ value: '{to}' })
    expect(t.saved[0].permissions).toEqual({ input: true, network: [] })
  })

  it('starts the recorder for "watch me make a skill"', () => {
    const t = setup()
    expect(t.c.intercept('watch me make a skill to export png')).toBe(HANDLED)
    expect(t.deps.startRecording).toHaveBeenCalledWith('export png')
  })

  it('offers a draft from a recording', async () => {
    const t = setup()
    await t.c.fromRecording({
      app: { id: 'gimp', name: 'GIMP' },
      title: 'export png',
      steps: [
        { kind: 'invoked', name: 'Export As…', role: 'menu item', opened: [] },
        { kind: 'text', name: 'Name', role: 'edit', opened: [] }
      ]
    })
    expect(t.said[0]).toMatch(/^Draft skill “export png”: Repeats your recorded steps in GIMP\./)
    expect(t.c.draft()?.steps?.steps).toHaveLength(2)
    expect(t.c.draft()?.params.map((p) => p.name)).toEqual(['name'])
  })
})
