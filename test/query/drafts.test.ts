// Waiting drafts and their review words: only the newest draft takes "save it" / "read it
// back", and bare "no" / "cancel" / "forget it" discard one only while nothing runs and nothing
// was asked after it. Explicit "discard it" / "don't save it" always discard.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/ai/providers', () => ({ getProvider: vi.fn() }))

import { beginScope, endScope } from '../../src/main/query/cancel'
import {
  bareCancelDiscards,
  claimsReview,
  isNewestDraft,
  newestDraft,
  noteTurnStarted,
  resetDrafts,
  setDraftSource
} from '../../src/main/query/drafts'
import { matchDraftCommand } from '../../src/main/skills/authoring'
import { matchDraftCommand as matchLessonDraft } from '../../src/main/teach/commands'
import { matchCodingSkillIntent } from '../../src/main/coding-skills/intents'
import { draftFromBuddyCompose, type BuddyComposeOutput } from '../../src/main/buddies/compose'
import { createBuddyCreation, setBuddyCreation } from '../../src/main/buddies/creation-voice'

beforeEach(() => resetDrafts())

describe('draft registry', () => {
  it('knows the newest waiting draft', () => {
    setDraftSource('skill', () => 100)
    setDraftSource('buddy', () => 200)
    setDraftSource('style', () => null)
    expect(newestDraft()).toEqual({ kind: 'buddy', at: 200 })
    expect(isNewestDraft('buddy', 200)).toBe(true)
    expect(isNewestDraft('skill', 100)).toBe(false)
    expect(claimsReview('skill', 100, { cmd: 'save' })).toBe(false)
    expect(claimsReview('buddy', 200, { cmd: 'save' })).toBe(true)
    setDraftSource('buddy', null)
    expect(isNewestDraft('skill', 100)).toBe(true)
  })

  it('a source that throws counts as no draft', () => {
    setDraftSource('lesson', () => {
      throw new Error('gone')
    })
    expect(newestDraft()).toBeNull()
  })

  it('bare cancel words discard only while nothing runs and nothing came after', () => {
    setDraftSource('style', () => 1000)
    expect(bareCancelDiscards('style', 1000)).toBe(true)
    const scope = beginScope()
    expect(bareCancelDiscards('style', 1000)).toBe(false)
    expect(claimsReview('style', 1000, { cmd: 'discard', bare: true })).toBe(false)
    // Explicit words still go to the draft.
    expect(claimsReview('style', 1000, { cmd: 'discard' })).toBe(true)
    endScope(scope)
    expect(bareCancelDiscards('style', 1000)).toBe(true)
    noteTurnStarted(2000)
    expect(bareCancelDiscards('style', 1000)).toBe(false)
  })
})

describe('review words', () => {
  it('skill review: bare cancel words are marked, explicit ones are not', () => {
    expect(matchDraftCommand('cancel')).toEqual({ cmd: 'discard', bare: true })
    expect(matchDraftCommand('No.')).toEqual({ cmd: 'discard', bare: true })
    expect(matchDraftCommand('forget it')).toEqual({ cmd: 'discard', bare: true })
    expect(matchDraftCommand('discard it')).toEqual({ cmd: 'discard' })
    expect(matchDraftCommand('throw it away')).toEqual({ cmd: 'discard' })
    expect(matchDraftCommand("don't save it")).toEqual({ cmd: 'discard' })
  })

  it('lesson draft review: "forget it" is bare, "don\'t save it" is explicit', () => {
    expect(matchLessonDraft('forget it')).toEqual({ cmd: 'discard', bare: true })
    expect(matchLessonDraft("don't save it")).toEqual({ cmd: 'discard' })
    expect(matchLessonDraft('discard the draft')).toEqual({ cmd: 'discard' })
  })

  it('coding skill review: "forget it" is bare', () => {
    expect(matchCodingSkillIntent('forget it')).toEqual({
      kind: 'draft',
      cmd: 'discard',
      bare: true
    })
    expect(matchCodingSkillIntent('discard it')).toEqual({ kind: 'draft', cmd: 'discard' })
    expect(matchCodingSkillIntent("don't save it")).toEqual({ kind: 'draft', cmd: 'discard' })
  })
})

describe('buddy draft claims', () => {
  const out: BuddyComposeOutput = {
    name: 'Inbox Buddy',
    color: 'blue',
    emoji: 'M',
    description: 'Sums up new mail.',
    instructions: 'Read new mail.',
    tools: ['fetch_url'],
    websites: ['https://mail.example.com'],
    connectors: [],
    read_folders: [],
    write_folders: [],
    profile: false,
    needs_screen: false,
    skills: [],
    subagents: false,
    model: 'fast',
    report: 'notify',
    schedule: ''
  }

  function withDraft(at: number): ReturnType<typeof createBuddyCreation> {
    const c = createBuddyCreation({
      now: () => at,
      log: () => {},
      compose: async (description: string) => ({
        ok: true as const,
        ...draftFromBuddyCompose(out, { description }, { now: at })
      }),
      editWords: async () => null,
      connectors: async () => [],
      find: () => null,
      create: () => ({ ok: false, error: 'no' }),
      update: () => null
    })
    setBuddyCreation(c)
    return c
  }

  it('claims review words only while its draft is the newest', async () => {
    const c = withDraft(5000)
    expect(c.claims('save it')).toBe(false)
    await c.turn('make a buddy that sums up my mail', { say: () => {} })
    expect(c.pendingAt()).toBe(5000)
    expect(c.claims('save it')).toBe(true)
    expect(c.claims('read it back')).toBe(true)
    expect(c.claims('call it Mail Pal')).toBe(true)
    expect(c.claims('scroll down')).toBe(false)
    // A newer skill draft takes the generic words.
    setDraftSource('skill', () => 6000)
    expect(c.claims('save it')).toBe(false)
    setDraftSource('skill', null)
    // Bare "cancel" while a turn runs is that turn's cancel.
    const scope = beginScope()
    expect(c.claims('cancel')).toBe(false)
    expect(c.claims('discard it')).toBe(true)
    endScope(scope)
    expect(c.claims('cancel')).toBe(true)
    setBuddyCreation(null)
  })
})
