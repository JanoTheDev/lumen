// Buddy runs (08 T50): the background start input, the run settings the runner gets through the
// hook, the untrusted confirm rule, the monthly budget port, run history and the usage scope.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BackgroundTask } from '@shared/types'
import type { StartInput } from '../../src/main/agent-mode/background/manager'
import type { SkillEnvelope } from '../../src/main/agent-mode/skill-envelope'
import type { GuardHost } from '../../src/main/agent-mode/skill-run'
import type { LoadedSkill } from '../../src/main/skills/registry'
import { checkSkillCall } from '../../src/main/skills/permissions'
import { currentUsageScope } from '../../src/main/usage/scope'
import { Buddies, overBudget } from '../../src/main/buddies/service'
import { BuddyStore, IMPORT_MARKER } from '../../src/main/buddies/store'
import {
  buddyConfirmsEveryAction,
  buddyContext,
  buddyManifest,
  buddyStartInput
} from '../../src/main/buddies/run'
import { taskUsageScope } from '../../src/main/usage/task-scope'

let root: string
let started: StartInput[]
let tasks: BackgroundTask[]
let emitted: string[][]
let envelopes: { skill: LoadedSkill; taskId: string }[]
let spent: { usd: number; tokens: number } | null
let svc: Buddies
let store: BuddyStore

const host: GuardHost = { speak: () => {} }

function fakeTask(input: StartInput, n: number): BackgroundTask {
  return {
    id: `bg_test${n}`,
    title: input.title ?? input.prompt,
    prompt: input.prompt,
    ...(input.userText ? { userText: input.userText } : {}),
    origin: input.origin,
    ...(input.buddyId ? { buddyId: input.buddyId } : {}),
    phase: 'running',
    progress: [],
    counters: { modelCalls: 0, costUsd: 0, startedAt: 1000 + n }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lumen-buddy-run-'))
  started = []
  tasks = []
  emitted = []
  envelopes = []
  spent = null
  store = new BuddyStore(root, { now: () => Date.UTC(2026, 9, 2) })
  svc = new Buddies({
    store,
    start: (input) => {
      started.push(input)
      const t = fakeTask(input, started.length)
      tasks.push(t)
      return t
    },
    tasks: () => tasks,
    emit: (ids) => emitted.push(ids),
    envelope: (skill, taskId) => {
      envelopes.push({ skill, taskId })
      return { skill: skill.manifest.name } as SkillEnvelope
    },
    spend: () => () => spent,
    now: () => Date.UTC(2026, 9, 2)
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const inbox = (): ReturnType<Buddies['create']> =>
  svc.create({
    name: 'Inbox Buddy',
    instructions: 'Sum up new mail and flag anything from my boss.',
    permissions: {
      tools: ['fetch_url'],
      apps: [],
      input: false,
      network: ['https://mail.example.org'],
      files: { read: [], write: [] },
      connectors: ['gmail'],
      profile: false,
      risky: false,
      screen: false
    },
    model: 'main',
    budget: { perRunUsd: 0.1, perMonthUsd: 2 },
    skills: ['summarize-mail'],
    report: 'silent'
  })

describe('runBuddy', () => {
  it('starts a background task with origin buddy and the user words', () => {
    const b = inbox()
    const r = svc.run(b.id, { utterance: "  what's new? ", trigger: 'call' })
    expect(r.ok).toBe(true)
    expect(started).toHaveLength(1)
    const input = started[0]
    expect(input.origin).toBe('buddy')
    expect(input.buddyId).toBe('inbox-buddy')
    expect(input.userText).toBe("Sum up new mail and flag anything from my boss.\nwhat's new?")
    expect(input.prompt).toContain('You are “Inbox Buddy”')
    expect(input.prompt).toContain("The user asks you now: what's new?")
    expect(input.prompt).toContain('do not use notify')
    expect(input.title).toBe("Inbox Buddy: what's new")
    expect(emitted).toContainEqual(['inbox-buddy'])
  })

  it('a scheduled run has the instructions as its user words', () => {
    const b = inbox()
    const input = buddyStartInput(b, { trigger: 'schedule' })
    expect(input.userText).toBe(b.instructions)
    expect(input.prompt).toContain('This is a scheduled run')
    expect(input.title).toBe('Inbox Buddy: scheduled run')
  })

  it('a buddy schedule run counts toward its automation (usage review M3)', () => {
    const input = buddyStartInput(inbox(), { trigger: 'schedule', automationId: 'au_1' })
    expect(input.routineId).toBe('au_1')
    const scope = taskUsageScope({ id: 'bg_1', ...input })
    expect(scope).toMatchObject({ origin: 'buddy', buddyId: 'inbox-buddy', automationId: 'au_1' })
  })

  it('refuses a missing, turned off or over-budget buddy', () => {
    expect(svc.run('nobody', { trigger: 'manual' })).toMatchObject({ code: 'E_NOT_FOUND' })
    expect(svc.run('../x', { trigger: 'manual' })).toMatchObject({ code: 'E_NOT_FOUND' })
    const b = inbox()
    spent = { usd: 2.5, tokens: 0 }
    expect(svc.run(b.id, { trigger: 'manual' })).toMatchObject({ code: 'E_BUDGET' })
    spent = { usd: 0.5, tokens: 0 }
    expect(svc.run(b.id, { trigger: 'manual' }).ok).toBe(true)
    svc.setEnabled(b.id, false)
    expect(svc.run(b.id, { trigger: 'manual' })).toMatchObject({ code: 'E_OFF' })
    expect(started).toHaveLength(1)
  })

  it('checks the monthly token budget too', () => {
    const b = { ...inbox(), budget: { perRunUsd: 0.1, perMonthTokens: 5000 } }
    expect(overBudget(b, { usd: 0, tokens: 5000 })).toMatch(/tokens/)
    expect(overBudget(b, { usd: 0, tokens: 10 })).toBeNull()
    expect(overBudget(b, null)).toBeNull()
  })

  it('runs one at a time: a second call while it works is refused', () => {
    const b = inbox()
    expect(svc.run(b.id, { trigger: 'manual' }).ok).toBe(true)
    expect(svc.run(b.id, { trigger: 'schedule' })).toEqual({
      ok: false,
      code: 'E_BUSY',
      error: 'Inbox Buddy is already working on it.'
    })
    expect(started).toHaveLength(1)
    tasks[0].phase = 'done'
    expect(svc.run(b.id, { trigger: 'manual' }).ok).toBe(true)
  })

  it('lists its own runs newest first, without helpers', () => {
    const b = inbox()
    svc.run(b.id, { trigger: 'manual' })
    tasks[0].phase = 'done'
    svc.run(b.id, { utterance: 'again', trigger: 'call' })
    tasks.push({ ...tasks[0], id: 'bg_child1', parentId: tasks[0].id })
    tasks.push({ ...tasks[0], id: 'bg_other1', buddyId: 'someone-else' })
    expect(svc.runs(b.id).map((r) => r.taskId)).toEqual(['bg_test2', 'bg_test1'])
    const row = svc.summaries().find((s) => s.id === b.id)!
    expect(row.running).toBe(true)
    expect(row.lastRun?.taskId).toBe('bg_test2')
  })
})

describe('buddy run hook', () => {
  it('gives the runner the buddy envelope, model, cap, skills and notebook', () => {
    const b = inbox()
    store.appendNotebook(b.id, 'Boss is Ann.')
    const r = svc.run(b.id, { trigger: 'manual' })
    if (!r.ok) throw new Error(r.error)
    const env = svc.hook().forTask(r.task, host)
    if (typeof env === 'string') throw new Error(env)
    expect(env.role).toBe('main')
    expect(env.maxCostUsd).toBe(0.1)
    expect(env.subagents).toBe(false)
    expect(env.silent).toBe(true)
    expect(env.allowSkill('summarize-mail')).toBe(true)
    expect(env.allowSkill('delete-everything')).toBe(false)
    expect(env.context).toContain('<observed source="buddy-notebook">')
    expect(env.context).toContain('Boss is Ann.')
    expect(envelopes[0].taskId).toBe(`background:${r.task.id}`)
    expect(envelopes[0].skill.baseTrust).toBe('mine')
    expect(env.info.name).toBe('Inbox Buddy (buddy)')
    // memory_write goes to the buddy's notebook.
    expect(env.memoryWrite('Ann likes short summaries.')).toBe('ok')
    expect(svc.notebook(b.id)).toContain('Ann likes short summaries.')
    expect(svc.hook().silent(r.task)).toBe(true)
  })

  it('fails a task whose buddy is gone or off', () => {
    const b = inbox()
    const r = svc.run(b.id, { trigger: 'manual' })
    if (!r.ok) throw new Error(r.error)
    svc.setEnabled(b.id, false)
    expect(svc.hook().forTask(r.task, host)).toMatch(/turned off/)
    svc.remove(b.id)
    expect(svc.hook().forTask(r.task, host)).toMatch(/deleted/)
  })

  it('runs inside the buddy usage scope', async () => {
    const b = inbox()
    const r = svc.run(b.id, { trigger: 'manual' })
    if (!r.ok) throw new Error(r.error)
    const seen = await svc.hook().scope(r.task, async () => currentUsageScope())
    expect(seen).toMatchObject({ origin: 'buddy', buddyId: b.id, taskId: r.task.id })
    expect(currentUsageScope().origin).toBe('system')
  })

  it('has no notebook context when the notebook is empty', () => {
    expect(buddyContext('  \n')).toBe('')
  })
})

describe('buddy permissions as a skill manifest', () => {
  it('lists only its tools; run_subagents only with subagents', () => {
    const b = inbox()
    const m = buddyManifest(b)
    expect(m.tools).toEqual(['finish', 'ask_user', 'memory_write', 'notify', 'fetch_url'])
    expect(buddyManifest({ ...b, subagents: true }).tools).toContain('run_subagents')
    expect(buddyManifest({ ...b, report: 'cards' }).tools).toContain('present_cards')
    expect(checkSkillCall(m, 'mine', { kind: 'tool', tool: 'spawn_task' }).ok).toBe(false)
    expect(checkSkillCall(m, 'mine', { kind: 'tool', tool: 'fetch_url' }).ok).toBe(true)
    expect(
      checkSkillCall(m, 'mine', { kind: 'connector', tool: 'mcp__slack__post', server: 'slack' }).ok
    ).toBe(false)
  })

  it('an imported buddy confirms every connector call; the user’s own does not', () => {
    const b = inbox()
    const call = { kind: 'connector', tool: 'mcp__gmail__search', server: 'gmail' } as const
    expect(buddyConfirmsEveryAction(b)).toBe(false)
    expect(checkSkillCall(buddyManifest(b), b.trust, call)).toEqual({ ok: true, confirm: false })
    writeFileSync(join(root, b.id, IMPORT_MARKER), '{}')
    const imported = svc.get(b.id)!
    expect(imported.trust).toBe('community-untrusted')
    expect(buddyConfirmsEveryAction(imported)).toBe(true)
    expect(checkSkillCall(buddyManifest(imported), imported.trust, call)).toEqual({
      ok: true,
      confirm: true
    })
    const r = svc.run(b.id, { trigger: 'manual' })
    if (!r.ok) throw new Error(r.error)
    svc.hook().forTask(r.task, host)
    expect(envelopes.at(-1)!.skill.baseTrust).toBe('community-untrusted')
  })

  it('a risky buddy of the user’s own confirms too', () => {
    const b = inbox()
    expect(buddyConfirmsEveryAction({ ...b, permissions: { ...b.permissions, risky: true } })).toBe(
      true
    )
  })
})
