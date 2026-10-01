import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/a11y', () => ({ announce: vi.fn() }))
vi.mock('../../src/main/a11y/dispatch', () => ({ LOCAL_HANDLED: { handled: true } }))
vi.mock('../../src/main/ai/providers', () => ({ getProvider: vi.fn() }))
vi.mock('../../src/main/skills/index', () => ({ getSkillRegistry: () => null }))

import type { ModelResponse, SkillRunRecord } from '@shared/types'
import type { AgentRunTrace, SkillDraft } from '../../src/main/skills/authoring'
import { authorSkill, type ComposeOutput } from '../../src/main/skills/compose'
import {
  createSkillCreation,
  type CreationDeps,
  type SkillCreation
} from '../../src/main/skills/creation'
import { skillAuthoringHandlers } from '../../src/main/skills/agent-tools'
import type { EditOutput } from '../../src/main/skills/edit'
import { ProposalStore } from '../../src/main/skills/proposals'
import { parseSkillFile } from '../../src/main/skills/manifest'

const MORNING = `---
name: good-morning
description: "Opens the mail."
triggers: ["good morning"]
permissions:
  input: true
---
1. Open Outlook.
`

const composed: ComposeOutput = {
  name: 'tidy-desktop',
  description: 'Moves loose desktop files into folders by type.',
  when_to_use: 'when the user asks to tidy the desktop',
  triggers: ['tidy my desktop'],
  instructions: '1. Open File Explorer on the Desktop.\n2. Ask before moving anything.',
  params: [],
  apps: [],
  needs_input: true,
  websites: [],
  profile: false,
  connectors: [],
  tools: [],
  steps_json: '',
  references: []
}

interface Setup {
  c: SkillCreation
  deps: CreationDeps
  saved: SkillDraft[]
  edits: { name: string; files: { skillMd: string; stepsJson?: string | null } }[]
  said: string[]
  confirms: string[]
  tick(ms: number): number
  text(u: string): Promise<string>
  store: ProposalStore
  setEdit(o: EditOutput | null): void
}

function setup(opts: { confirm?: boolean; present?: boolean; hasSteps?: boolean } = {}): Setup {
  let now = 1_000_000
  let edit: EditOutput | null = null
  const saved: SkillDraft[] = []
  const edits: Setup['edits'] = []
  const said: string[] = []
  const confirms: string[] = []
  const store = new ProposalStore(null)
  const deps: CreationDeps = {
    now: () => now,
    words: vi.fn(async () => null),
    startRecording: vi.fn(() => ({ ok: true })),
    save: (d) => {
      saved.push(structuredClone(d))
      return { ok: true, name: d.name }
    },
    taken: () => false,
    say: (t) => said.push(t),
    log: () => {},
    handled: { handled: true },
    compose: (description) => authorSkill({ description }, { words: async () => composed }),
    editWords: vi.fn(async () => edit),
    skills: () => [
      { name: 'good-morning', triggers: ['good morning'] },
      { name: 'export-png', triggers: [] }
    ],
    skillText: (name) =>
      name === 'good-morning' || name === 'export-png'
        ? { text: MORNING.replace('good-morning', name), hasSteps: !!opts.hasSteps }
        : null,
    saveEdit: (name, files) => {
      edits.push({ name, files })
      return { ok: true }
    },
    proposals: store,
    canSpeakUp: () => opts.present ?? true,
    notice: (t) => said.push(t),
    covered: () => false,
    confirm: async (summary) => {
      confirms.push(summary)
      return opts.confirm ?? true
    },
    later: (fn) => fn()
  }
  const c = createSkillCreation(deps)
  return {
    c,
    deps,
    saved,
    edits,
    said,
    confirms,
    store,
    tick: (ms: number) => (now += ms),
    text: async (u: string) => ((await c.intercept(u)) as ModelResponse & { text: string }).text,
    setEdit: (o) => (edit = o)
  }
}

const trace = (prompt: string, at = 1_000_000): AgentRunTrace => ({
  prompt,
  summary: 'Done.',
  at,
  steps: [
    { tool: 'act', op: 'invoke', element: { name: 'File' } },
    { tool: 'act', op: 'invoke', element: { name: 'Export As' } }
  ]
})

describe('"make a skill that …"', () => {
  it('drafts a model-written skill with a spoken permissions preview, then saves it', async () => {
    const t = setup()
    const line = await t.text('make a skill that tidies my desktop')
    expect(line).toMatch(
      /^Draft skill “tidy desktop”: Moves loose desktop files into folders by type\. It may use your mouse and keyboard\. Say “save it”/
    )
    expect(await t.text('read it back')).toMatch(/Say “tidy my desktop” to run it\. It may use/)
    expect(await t.text('save it')).toMatch(/Saved the skill “tidy desktop”/)
    expect(t.saved[0]).toMatchObject({
      source: 'model',
      whenToUse: 'when the user asks to tidy the desktop'
    })
  })

  it('says why when the model fails', async () => {
    const t = setup()
    t.deps.compose = async () => ({ ok: false, error: 'the AI did not return a skill' })
    expect(await t.text('create a skill for my taxes')).toBe(
      'I could not write that skill: the AI did not return a skill.'
    )
  })
})

describe('voice edits', () => {
  const after = MORNING.replace(
    'description: "Opens the mail."',
    'description: "Opens the mail and Slack."'
  ).replace('1. Open Outlook.', '1. Open Outlook.\n2. Open Slack.')

  it('shows the diff and saves on "save it"', async () => {
    const t = setup()
    t.setEdit({ skill_md: after, summary: 'It now also opens Slack.', steps_still_match: true })
    const line = await t.text('change my morning skill to also open Slack')
    expect(line).toMatch(/^Change to “good morning”: It now also opens Slack\./)
    expect(await t.text('read it back')).toMatch(/1 instruction line added/)
    expect(await t.text('call it evening')).toMatch(/keeps its name/)
    expect(await t.text('save it')).toBe('Saved the change to “good morning”.')
    expect(t.edits[0].name).toBe('good-morning')
    expect(parseSkillFile(t.edits[0].files.skillMd).manifest.description).toBe(
      'Opens the mail and Slack.'
    )
    expect(t.edits[0].files.stepsJson).toBeUndefined()
  })

  it('drops steps that no longer fit, and discards on request', async () => {
    const t = setup({ hasSteps: true })
    t.setEdit({ skill_md: after, summary: 'It now also opens Slack.', steps_still_match: false })
    expect(await t.text('change the good morning skill to also open Slack')).toMatch(
      /recorded steps are removed/
    )
    expect(await t.text('discard it')).toMatch(/Change discarded/)
    expect(t.edits).toEqual([])
  })

  it('asks which skill, or says it is unknown', async () => {
    const t = setup()
    expect(await t.text('make the banana skill more formal')).toMatch(/can't find a skill/)
  })

  it('rewrites a stale skill from its last good run ("update it")', async () => {
    const t = setup({ hasSteps: true })
    t.setEdit({
      skill_md: after.replace('good-morning', 'export-png'),
      summary: 'Rewritten from the last run.',
      steps_still_match: true
    })
    t.c.rememberRun(trace('export as png'))
    const rec = (how: SkillRunRecord['how']): SkillRunRecord => ({
      at: 1_000_000 - 10,
      ms: 100,
      how,
      status: 'done',
      summary: '',
      actions: 2
    })
    t.c.skillRan('export-png', rec('steps+agent'), [rec('steps+agent'), rec('steps+agent')])
    expect(t.said.at(-1)).toMatch(/did not go as recorded.*update the export png skill/)
    // Only once.
    t.c.skillRan('export-png', rec('steps+agent'), [rec('steps+agent'), rec('steps+agent')])
    expect(t.said.filter((s) => /did not go/.test(s))).toHaveLength(1)
    expect(await t.text('update it')).toMatch(/replaced with 2 from the last run that worked/)
    await t.text('save it')
    expect(JSON.parse(t.edits[0].files.stepsJson!).steps).toHaveLength(2)
    expect((t.deps.editWords as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /<observed>[\s\S]*Export As/
    )
  })
})

describe('offers to save a task as a skill', () => {
  it('offers on the second alike run and saves on yes', async () => {
    const t = setup()
    t.c.rememberRun(trace('export the image as png'))
    expect(t.said).toEqual([])
    t.c.rememberRun(trace('export the image as png'))
    expect(t.said[0]).toMatch(/Want me to save it as a skill\?/)
    expect(await t.text('yes')).toMatch(/^Draft skill/)
  })

  it('remembers a no and stays quiet when the user is away', async () => {
    const t = setup()
    t.c.rememberRun(trace('export the image as png'))
    t.c.rememberRun(trace('export the image as png'))
    expect(await t.text('no thanks')).toMatch(/not ask about this one again/)
    t.c.rememberRun(trace('export the image as png'))
    expect(t.said).toHaveLength(1)

    const away = setup({ present: false })
    away.c.rememberRun(trace('crop the photo'))
    away.c.rememberRun(trace('crop the photo'))
    expect(away.said).toEqual([])
  })

  it('offers after a correction during the task', () => {
    const t = setup()
    t.c.noteTask({ prompt: 'rename the layer', phase: 'running' })
    expect(t.c.intercept('no, the other layer')).toBeUndefined()
    t.c.rememberRun(trace('rename the layer'))
    expect(t.said[0]).toMatch(/took a correction/)
  })

  it('offers after a failed attempt that then worked', () => {
    const t = setup()
    t.c.noteTask({ prompt: 'rename the top layer', phase: 'running' })
    t.c.noteTask({ prompt: 'rename the top layer', phase: 'failed' })
    t.c.noteTask(null)
    t.c.rememberRun(trace('rename the top layer please'))
    expect(t.said[0]).toMatch(/took a correction/)
  })

  it('turns offers off and on by voice', async () => {
    const t = setup()
    t.c.rememberRun(trace('export the image as png'))
    t.c.rememberRun(trace('export the image as png'))
    expect(await t.text('stop offering skills')).toMatch(/stop offering/)
    expect(t.store.data.off).toBe(true)
    expect(await t.text('start offering skills again')).toMatch(/again/)
    expect(t.store.data.off).toBe(false)
  })

  it('never offers a skill run as a new skill', () => {
    const t = setup()
    t.deps.later = (fn) => setTimeout(fn, 0)
    vi.useFakeTimers()
    try {
      const r = trace('export the image as png')
      t.c.rememberRun(r)
      vi.runAllTimers()
      t.c.rememberRun({ ...r })
      // The skill's history arrives before the deferred check.
      t.c.skillRan(
        'export-png',
        { at: 1_000_000, ms: 10, how: 'agent', status: 'done', summary: '', actions: 2 },
        []
      )
      vi.runAllTimers()
      expect(t.said).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('agent tools create_skill / update_skill', () => {
  const input = {
    name: 'Weekly Report',
    description: 'Builds the weekly report.',
    triggers: ['weekly report'],
    instructions: '1. Open the report sheet.',
    needs_input: true,
    websites: ['https://docs.example.com'],
    why: 'You do this every Friday.'
  }

  it('confirms on the bar and saves, once per task', async () => {
    const t = setup()
    const h = skillAuthoringHandlers(() => t.c)
    const r = await h.create_skill(input)
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toMatch(/Saved the skill "weekly-report"/)
    expect(t.confirms[0]).toMatch(
      /Save a new skill “weekly report”\? Builds the weekly report\. \(You do this every Friday\.\) It may use your mouse and keyboard and open docs\.example\.com\./
    )
    expect(t.saved[0].permissions).toEqual({ input: true, network: ['https://docs.example.com'] })
    const again = await h.create_skill(input)
    expect(again.isError).toBe(true)
  })

  it('saves nothing when the user says no', async () => {
    const t = setup({ confirm: false })
    const r = await skillAuthoringHandlers(() => t.c).create_skill(input)
    expect(r.content[0].text).toMatch(/said no/)
    expect(t.saved).toEqual([])
  })

  it('updates a skill after the confirm card', async () => {
    const t = setup()
    t.setEdit({
      skill_md: MORNING.replace('1. Open Outlook.', '1. Open Outlook.\n2. Be formal.'),
      summary: 'It is more formal now.',
      steps_still_match: true
    })
    const h = skillAuthoringHandlers(() => t.c)
    const r = await h.update_skill({ name: 'good-morning', change: 'more formal' })
    expect(r.content[0].text).toBe('Saved the change to “good morning”.')
    expect(t.confirms[0]).toMatch(/^Change to “good morning”: It is more formal now\./)
    expect((await h.update_skill({ name: 'nope', change: 'x' })).isError).toBe(true)
    expect(
      (await skillAuthoringHandlers(() => t.c).update_skill({ name: 'nope', change: 'x' }))
        .content[0].text
    ).toMatch(/no skill named/)
    expect((await h.create_skill({})).isError).toBe(true)
  })
})
