// Buddies the model writes (08 T51): least-privilege clamp of the model's output, the schedule
// parsed locally, names kept free, and the spoken permissions line. The model is a fake.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/ai/providers', () => ({ getProvider: vi.fn() }))

import {
  authorBuddy,
  buddyComposeTurn,
  buddyPermissionWords,
  draftFromBuddyCompose,
  freeBuddyName,
  parseSchedule,
  type BuddyComposeOutput
} from '../../src/main/buddies/compose'
import { clampPermissions } from '../../src/main/buddies/clamp'

const NOW = new Date(2026, 9, 2, 7, 0).getTime()
const DOWNLOADS = 'C:\\Users\\sam\\Downloads'

function output(over: Partial<BuddyComposeOutput> = {}): BuddyComposeOutput {
  return {
    name: 'Inbox Buddy',
    color: 'Purple',
    emoji: '📬',
    description: 'Sums up new mail every morning and flags mail from the boss.',
    instructions: '1. Read new mail.\n2. Flag mail from the boss.\n3. Report three lines.',
    tools: ['fetch_url', 'click', 'memory_search'],
    websites: ['https://news.example.com/page', 'http://plain.example.com', '*.com'],
    connectors: ['gmail', 'evil'],
    read_folders: ['Downloads', 'D:\\..\\secret'],
    write_folders: [],
    profile: false,
    needs_screen: false,
    skills: ['morning-mail', 'not-installed'],
    subagents: false,
    model: 'main',
    report: 'weird',
    schedule: 'every weekday at 8',
    ...over
  }
}

const req = {
  description: 'a buddy that checks my mail every weekday morning',
  connectors: ['gmail'],
  skills: ['morning-mail']
}
const resolveFolder = (n: string): string | null =>
  n.toLowerCase() === 'downloads' ? DOWNLOADS : null

describe('draftFromBuddyCompose', () => {
  it('clamps the model output to least privilege', () => {
    const { draft, warnings } = draftFromBuddyCompose(output(), req, { now: NOW, resolveFolder })
    expect(draft.name).toBe('Inbox Buddy')
    expect(draft.look).toEqual({ color: '#c47fd5', emoji: '📬' })
    expect(draft.permissions.tools).toEqual(['fetch_url', 'memory_search'])
    expect(draft.permissions.network).toEqual(['https://news.example.com'])
    expect(draft.permissions.connectors).toEqual(['gmail'])
    expect(draft.permissions.files.read).toEqual([DOWNLOADS])
    expect(draft.permissions.input).toBe(false)
    expect(draft.permissions.screen).toBe(false)
    expect(draft.permissions.risky).toBe(false)
    expect(draft.skills).toEqual(['morning-mail'])
    expect(draft.model).toBe('main')
    expect(draft.report).toBe('notify')
    expect(draft.budget.perRunUsd).toBe(0.25)
    expect(draft.instructions.split('\n')[0]).toBe(draft.description)
    expect(warnings.join(' ')).toMatch(/plain\.example\.com/)
    expect(warnings.join(' ')).toMatch(/evil/)
    expect(warnings.join(' ')).toMatch(/secret/)
  })

  it('proposes the schedule parsed locally, never creating it', () => {
    const { draft } = draftFromBuddyCompose(output(), req, { now: NOW })
    expect(draft.schedule?.text).toBe('every weekday at 8')
    expect(draft.schedule?.trigger).toMatchObject({ kind: 'daily', at: '08:00' })
    expect(draft.schedule?.description).toMatch(/08:00/)
  })

  it('drops an unparsable schedule with a note', () => {
    const { draft, warnings } = draftFromBuddyCompose(
      output({ schedule: 'whenever the moon is full' }),
      req,
      { now: NOW }
    )
    expect(draft.schedule).toBeUndefined()
    expect(warnings.join(' ')).toMatch(/moon/)
  })

  it('adds fetch_url when it must read websites, and a screen buddy gets input', () => {
    const { draft } = draftFromBuddyCompose(
      output({ tools: [], needs_screen: true, websites: ['https://shop.example.com'] }),
      req,
      { now: NOW }
    )
    expect(draft.permissions.tools).toEqual(['fetch_url'])
    expect(draft.permissions.screen).toBe(true)
    expect(draft.permissions.input).toBe(true)
  })

  it('keeps the name free and falls back to an initial for a bad emoji', () => {
    const { draft } = draftFromBuddyCompose(output({ emoji: 'abc', color: 'neon' }), req, {
      taken: (n) => n === 'Inbox Buddy',
      now: NOW
    })
    expect(draft.name).toBe('Inbox Buddy 2')
    expect(draft.look).toEqual({ color: '#5b8def', initial: 'I' })
  })
})

describe('authorBuddy', () => {
  it('writes a draft from the fake model and passes the lists in the turn', async () => {
    let turn = ''
    const r = await authorBuddy(
      { ...req, connectorNames: { gmail: 'Work mail' } },
      {
        now: NOW,
        words: async (t) => {
          turn = t
          return output()
        }
      }
    )
    expect(r.ok).toBe(true)
    expect(turn).toContain('gmail (Work mail)')
    expect(turn).toContain('morning-mail')
  })

  it('fails cleanly without a description, model output or on a model error', async () => {
    expect((await authorBuddy({ description: 'x' }, { words: async () => output() })).ok).toBe(
      false
    )
    expect((await authorBuddy(req, { words: async () => null })).ok).toBe(false)
    const r = await authorBuddy(req, {
      words: async () => {
        throw new Error('offline')
      }
    })
    expect(r).toEqual({ ok: false, error: 'the AI could not write it (offline)' })
  })

  it('builds a turn with the description', () => {
    expect(buddyComposeTurn({ description: 'watch prices' })).toMatch(/watch prices/)
  })
})

describe('helpers', () => {
  it('freeBuddyName counts up', () => {
    const taken = new Set(['Price Buddy', 'Price Buddy 2'])
    expect(freeBuddyName('Price Buddy', (n) => taken.has(n))).toBe('Price Buddy 3')
  })

  it('parseSchedule: empty is none, a bad phrase gives a reason', () => {
    expect(parseSchedule('', { now: NOW })).toBeNull()
    expect(parseSchedule('every day at 9', { now: NOW })).toMatchObject({
      schedule: { trigger: { kind: 'daily', at: '09:00' } }
    })
    expect(parseSchedule('banana', { now: NOW })).toHaveProperty('reason')
  })

  it('buddyPermissionWords says what it may do', () => {
    expect(buddyPermissionWords(clampPermissions({}))).toBe(
      'It only uses its notebook and answers.'
    )
    const line = buddyPermissionWords(
      clampPermissions({
        tools: ['fetch_url', 'create_file'],
        network: ['https://shop.example.com'],
        files: { read: [DOWNLOADS] },
        connectors: ['gmail'],
        screen: true
      })
    )
    expect(line).toMatch(/^It may read .*shop\.example\.com/)
    expect(line).toMatch(/read files in Downloads/)
    expect(line).toMatch(/connectors gmail/)
    expect(line).toMatch(/work on your screen/)
    expect(line).toMatch(/create file/)
  })
})
