// Making buddies by voice (08 T51): the "make a buddy" grammar, the draft review (save, call
// it, read it back, discard), voice edits with the card for wider permissions, rename, and the
// "Want a buddy for this?" offer. Fake model and buddies.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/ai/providers', () => ({ getProvider: vi.fn() }))

import type { Buddy, BuddyDraft } from '@shared/buddies'
import { clampBuddy, buddyIdFor } from '../../src/main/buddies/clamp'
import { draftFromBuddyCompose, type BuddyComposeOutput } from '../../src/main/buddies/compose'
import {
  BUDDY_DRAFT_MS,
  buddyCreationTurn,
  createBuddyCreation,
  matchBuddyComposeIntent,
  setBuddyCreation,
  type BuddyCreationDeps,
  type BuddyScheduler
} from '../../src/main/buddies/creation-voice'
import type { BuddyEditOutput } from '../../src/main/buddies/edit'
import { BuddyOfferStore, OFFER_GAP_MS, OFFER_LINE } from '../../src/main/buddies/offers'

const out: BuddyComposeOutput = {
  name: 'Inbox Buddy',
  color: 'blue',
  emoji: '📬',
  description: 'Sums up new mail every morning.',
  instructions: '1. Read new mail.\n2. Report three lines.',
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
  schedule: 'every weekday at 8'
}

let now: number
let buddies: Map<string, Buddy>
let said: string[]
let scheduled: { id: string; text: string | null }[]
let editOut: BuddyEditOutput | null
let deps: BuddyCreationDeps

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

function setup(over: Partial<BuddyCreationDeps> = {}): ReturnType<typeof createBuddyCreation> {
  const scheduler: BuddyScheduler = async (b, s) => {
    scheduled.push({ id: b.id, text: s?.text ?? null })
    return { ok: true, text: s ? `It runs ${s.description}.` : 'It no longer runs by itself.' }
  }
  deps = {
    now: () => now,
    log: () => {},
    compose: vi.fn(async (description: string) => ({
      ok: true as const,
      ...draftFromBuddyCompose(out, { description }, { now })
    })),
    editWords: vi.fn(async () => editOut),
    connectors: async () => ['outlook'],
    find: (name) => [...buddies.values()].find((b) => norm(b.name) === norm(name)) ?? null,
    create: (draft: BuddyDraft) => {
      const id = buddyIdFor(draft.name, (x) => buddies.has(x))
      const b = clampBuddy(id, { ...draft, trust: 'mine' })
      buddies.set(id, b)
      return { ok: true, buddy: b }
    },
    update: (id, patch) => {
      const b = buddies.get(id)
      if (!b) return null
      const next = clampBuddy(id, { ...b, ...patch })
      buddies.set(id, next)
      return next
    },
    scheduler: () => scheduler,
    ...over
  }
  return createBuddyCreation(deps)
}

const ctx = { say: (t: string) => void said.push(t) }

beforeEach(() => {
  now = new Date(2026, 9, 2, 7, 0).getTime()
  buddies = new Map()
  said = []
  scheduled = []
  editOut = null
})

describe('matchBuddyComposeIntent', () => {
  it('reads the ways to ask', () => {
    expect(matchBuddyComposeIntent('Make a buddy that checks my mail every morning.')).toEqual({
      description: 'checks my mail every morning'
    })
    expect(matchBuddyComposeIntent('make me a buddy for price tracking')).toEqual({
      description: 'price tracking'
    })
    expect(
      matchBuddyComposeIntent('create a buddy called Price Buddy that watches headphone prices')
    ).toEqual({ description: 'watches headphone prices', name: 'Price Buddy' })
    expect(matchBuddyComposeIntent('make a buddy called Max')).toEqual({
      description: '',
      name: 'Max'
    })
  })

  it('leaves other requests alone', () => {
    expect(matchBuddyComposeIntent('make a skill that opens mail')).toBeNull()
    expect(matchBuddyComposeIntent('Inbox Buddy, what is new?')).toBeNull()
  })
})

describe('draft review', () => {
  it('makes, renames, reads back and saves a draft with its schedule', async () => {
    const c = setup()
    expect(await c.turn('make a buddy that checks my mail every weekday at 8', ctx)).toBe(true)
    expect(said[0]).toMatch(/^Draft buddy “Inbox Buddy”: Sums up new mail/)
    expect(said[0]).toMatch(/It may read mail\.example\.com|It may read .*mail\.example\.com/)
    expect(said[0]).toMatch(/It would run every weekday/)
    expect(said[0]).toMatch(/Say “save it”/)
    expect(c.pending()?.name).toBe('Inbox Buddy')

    expect(await c.turn('call it mail buddy', ctx)).toBe(true)
    expect(said[1]).toBe('Renamed it to “Mail Buddy”. Say “save it” to keep it.')
    expect(await c.turn('read it back', ctx)).toBe(true)
    expect(said[2]).toMatch(/^Mail Buddy\. Sums up new mail/)

    expect(await c.turn('save it', ctx)).toBe(true)
    expect(said[3]).toMatch(/^Saved “Mail Buddy”\. Say “Mail Buddy, …” to give it work\. It runs/)
    expect(buddies.get('mail-buddy')?.trust).toBe('mine')
    expect(scheduled).toEqual([{ id: 'mail-buddy', text: 'every weekday at 8' }])
    expect(c.pending()).toBeNull()
    expect(await c.turn('save it', ctx)).toBe(false)
  })

  it('uses the name the user gave and discards on request', async () => {
    const c = setup()
    await c.turn('create a buddy called price buddy that watches headphone prices', ctx)
    expect(c.pending()?.name).toBe('Price Buddy')
    expect(await c.turn('discard it', ctx)).toBe(true)
    expect(said[1]).toBe('Draft buddy discarded.')
    expect(buddies.size).toBe(0)
  })

  it('a draft expires and a late "yes" is not taken', async () => {
    const c = setup()
    await c.turn('make a buddy that checks my mail', ctx)
    now += 3 * 60_000
    expect(await c.turn('yes', ctx)).toBe(false)
    now += BUDDY_DRAFT_MS
    expect(await c.turn('save it', ctx)).toBe(false)
  })

  it('without a scheduler the schedule is left for Settings', async () => {
    const c = setup({ scheduler: () => null })
    await c.turn('make a buddy that checks my mail', ctx)
    await c.turn('save it', ctx)
    expect(said[1]).toMatch(/can be set in Settings, Buddies/)
  })

  it('a failed compose is said', async () => {
    const c = setup({ compose: async () => ({ ok: false, error: 'no key' }) })
    await c.turn('make a buddy that checks my mail', ctx)
    expect(said[0]).toBe('I could not write that buddy: no key.')
  })

  it('module entry is false before install', async () => {
    setBuddyCreation(null)
    expect(await buddyCreationTurn('make a buddy that checks my mail', ctx)).toBe(false)
  })
})

describe('voice edits', () => {
  beforeEach(() => {
    buddies.set(
      'inbox-buddy',
      clampBuddy('inbox-buddy', {
        name: 'Inbox Buddy',
        trust: 'mine',
        instructions: 'Sums up new mail.',
        permissions: { tools: ['fetch_url'], network: ['https://mail.example.com'] }
      })
    )
  })

  const edit = (over: Partial<BuddyEditOutput> = {}): BuddyEditOutput => ({
    instructions: 'Sums up new mail.\n\nAlso check Outlook.',
    tools: ['fetch_url'],
    websites: ['https://mail.example.com'],
    connectors: ['outlook'],
    read_folders: [],
    write_folders: [],
    profile: false,
    needs_screen: false,
    model: 'fast',
    report: 'notify',
    schedule: '',
    summary: 'It now also checks Outlook.',
    ...over
  })

  it('speaks the change with wider permissions and asks the card before saving', async () => {
    editOut = edit()
    const c = setup()
    const card = vi.fn(async () => true)
    expect(await c.turn('tell Inbox Buddy to also check Outlook', { ...ctx, showCard: card })).toBe(
      true
    )
    expect(said[0]).toMatch(/^It now also checks Outlook\. It may now use the connectors outlook\./)
    expect(await c.turn('save it', { ...ctx, showCard: card })).toBe(true)
    expect(card).toHaveBeenCalledOnce()
    expect(buddies.get('inbox-buddy')?.permissions.connectors).toEqual(['outlook'])
    expect(said[1]).toBe('Saved the change to Inbox Buddy.')
  })

  it('a "no" on the card keeps the buddy as it was', async () => {
    editOut = edit()
    const c = setup()
    const c2 = { ...ctx, showCard: async () => false }
    await c.turn('tell inbox buddy to also check Outlook', c2)
    await c.turn('save it', c2)
    expect(buddies.get('inbox-buddy')?.permissions.connectors).toEqual([])
    expect(said[1]).toMatch(/Change discarded/)
  })

  it('a schedule change goes to the scheduler on save', async () => {
    editOut = edit({ connectors: [], schedule: 'every day at 9', summary: 'It runs at 9 now.' })
    const c = setup()
    await c.turn('change Inbox Buddy to run at 9', ctx)
    expect(said[0]).toMatch(/It would run every day/)
    await c.turn('save it', ctx)
    expect(scheduled).toEqual([{ id: 'inbox-buddy', text: 'every day at 9' }])
  })

  it('work for now is not an edit (the calling grammar takes it)', async () => {
    const c = setup()
    expect(await c.turn('tell Inbox Buddy to check my mail now', ctx)).toBe(false)
    expect(await c.turn('Inbox Buddy, what is new?', ctx)).toBe(false)
  })

  it('renames right away and refuses a taken name', async () => {
    buddies.set('price-buddy', clampBuddy('price-buddy', { name: 'Price Buddy', trust: 'mine' }))
    const c = setup()
    await c.turn('rename inbox buddy to price buddy', ctx)
    expect(said[0]).toBe('You already have a buddy called Price Buddy.')
    await c.turn('rename inbox buddy to mail buddy', ctx)
    expect(said[1]).toBe('Renamed Inbox Buddy to Mail Buddy.')
    expect(buddies.get('inbox-buddy')?.name).toBe('Mail Buddy')
  })
})

describe('offers', () => {
  it('offers once after the same recurring ask twice; yes writes a draft', async () => {
    const offers = new BuddyOfferStore(null)
    const c = setup({ offers })
    const notices: string[] = []
    const host = { notice: (t: string) => void notices.push(t), canSpeakUp: () => true }
    c.noteRequest('check my inbox for mail from my boss', host)
    expect(notices).toEqual([])
    now += OFFER_GAP_MS + 1
    c.noteRequest('check my inbox for new mail from my boss', host)
    expect(notices).toEqual([OFFER_LINE])
    expect(await c.turn('yes', ctx)).toBe(true)
    expect(said[0]).toMatch(/^Draft buddy/)
    expect(deps.compose).toHaveBeenCalledWith(
      expect.stringContaining('check my inbox for new mail from my boss'),
      undefined
    )
    now += OFFER_GAP_MS + 1
    c.noteRequest('check my inbox for mail from my boss', host)
    expect(notices).toHaveLength(1)
  })

  it('no offer when away, and "stop offering buddies" turns them off', async () => {
    const offers = new BuddyOfferStore(null)
    const c = setup({ offers })
    const notices: string[] = []
    c.noteRequest('check the price of the sony headphones', {
      notice: (t) => void notices.push(t),
      canSpeakUp: () => false
    })
    now += OFFER_GAP_MS + 1
    c.noteRequest('check the price of the sony headphones', {
      notice: (t) => void notices.push(t),
      canSpeakUp: () => false
    })
    expect(notices).toEqual([])
    expect(await c.turn('stop offering buddies', ctx)).toBe(true)
    expect(offers.data.off).toBe(true)
  })
})
