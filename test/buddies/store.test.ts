// Buddy files (08 T50): round trip, clamp on load, id validation, the notebook cap and the
// private-mode rule. Every test writes to a temp folder, never the real home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BUDDY_NOTEBOOK_MAX_BYTES } from '@shared/buddies'
import {
  BuddyStore,
  buddyFileText,
  capNotebook,
  IMPORT_MARKER,
  parseBuddyFile
} from '../../src/main/buddies/store'
import { buddyIdFor, clampBuddy, folderAllowed, isBuddyId } from '../../src/main/buddies/clamp'
import { Buddies } from '../../src/main/buddies/service'

let root: string
let writable = true
let store: BuddyStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lumen-buddies-'))
  writable = true
  store = new BuddyStore(root, {
    canWrite: () => writable,
    sensitive: (t) => /password/i.test(t),
    now: () => Date.UTC(2026, 9, 2, 8)
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('buddy store', () => {
  it('round-trips a buddy through buddy.md', () => {
    const b = store.create({
      name: 'Inbox Buddy',
      look: { color: '#33AAFF', emoji: '📬' },
      instructions: 'Every weekday sum up new mail.\n\nFlag anything from "my boss": #urgent',
      permissions: {
        tools: ['fetch_url', 'memory_search'],
        apps: [],
        input: false,
        network: ['https://mail.example.org/inbox'],
        files: { read: ['C:\\Users\\me\\Documents\\Mail'], write: [] },
        connectors: ['gmail'],
        profile: true,
        risky: false,
        screen: false
      },
      model: 'main',
      budget: { perRunUsd: 0.1, perMonthUsd: 3 },
      skills: ['summarize-mail'],
      subagents: true,
      report: 'spoken',
      scheduleIds: ['au_1']
    })
    expect(b.id).toBe('inbox-buddy')
    expect(b.trust).toBe('mine')
    const again = store.get('inbox-buddy')
    expect(again).toEqual(b)
    expect(again!.look).toEqual({ color: '#33aaff', emoji: '📬' })
    expect(again!.permissions.network).toEqual(['https://mail.example.org'])
    expect(again!.instructions).toContain('"my boss": #urgent')
    expect(readdirSync(join(root, 'inbox-buddy'))).toEqual(['buddy.md'])
  })

  it('gives a second buddy with the same name a free id', () => {
    store.create({ name: 'Price Buddy' })
    expect(store.create({ name: 'Price Buddy' }).id).toBe('price-buddy-2')
    expect(store.list().map((b) => b.id)).toEqual(['price-buddy', 'price-buddy-2'])
  })

  it('keeps names unique: a new one gets a number, a rename to a taken name is refused', () => {
    expect(store.create({ name: 'Price Buddy' }).name).toBe('Price Buddy')
    expect(store.create({ name: 'price  buddy' }).name).toBe('price buddy 2')
    const svc = new Buddies({
      store,
      start: () => {
        throw new Error('no runs here')
      },
      tasks: () => [],
      emit: () => {},
      envelope: () => {
        throw new Error('no envelopes here')
      }
    })
    const other = store.create({ name: 'Inbox Buddy' })
    expect(() => svc.update(other.id, { name: 'PRICE BUDDY' })).toThrow(/already have a buddy/)
    expect(svc.update(other.id, { name: 'Inbox buddy' })?.name).toBe('Inbox buddy')
    expect(svc.update(other.id, { enabled: false })?.enabled).toBe(false)
  })

  it('clamps a hand-edited buddy.md on load', () => {
    const b = store.create({ name: 'Wide' })
    const raw = parseBuddyFile(readFileSync(join(root, b.id, 'buddy.md'), 'utf8'))
    const widened = {
      ...raw,
      permissions: {
        tools: ['fetch_url', 'act', 'request_foreground', 'keys'],
        apps: ['notepad'],
        input: false,
        network: ['http://plain.example.org', 'https://*.com', 'https://*.shop.example.org'],
        files: { read: ['\\\\server\\share', 'C:\\', 'C:\\Users\\me\\..\\x', 'D:\\Docs'] },
        connectors: ['ok-one', 'Bad_ID'],
        screen: 'yes'
      },
      model: 'vision-refine',
      budget: { perRunUsd: 50, perMonthUsd: -1 },
      report: 'shout'
    }
    writeFileSync(
      join(root, b.id, 'buddy.md'),
      buddyFileText({ ...b, ...(widened as object) } as never)
    )
    const got = store.get(b.id)!
    expect(got.permissions.tools).toEqual(['fetch_url'])
    expect(got.permissions.apps).toEqual([])
    expect(got.permissions.network).toEqual(['https://*.shop.example.org'])
    expect(got.permissions.files.read).toEqual(['D:\\Docs'])
    expect(got.permissions.connectors).toEqual(['ok-one'])
    expect(got.permissions.screen).toBe(false)
    expect(got.model).toBe('fast')
    expect(got.budget).toEqual({ perRunUsd: 0.25 })
    expect(got.report).toBe('notify')
  })

  it('keeps an imported buddy untrusted whatever its file says', () => {
    const b = store.create({ name: 'Shared One' })
    expect(b.trust).toBe('mine')
    writeFileSync(join(root, b.id, IMPORT_MARKER), '{}')
    expect(store.get(b.id)!.trust).toBe('community-untrusted')
    expect(store.save({ ...store.get(b.id)!, trust: 'mine' }).trust).toBe('community-untrusted')
  })

  it('treats a header without trust as untrusted', () => {
    expect(clampBuddy('x', { name: 'X' }).trust).toBe('community-untrusted')
  })

  it('skips broken files and refuses unsafe ids', () => {
    store.create({ name: 'Good' })
    const bad = join(root, 'broken')
    mkdirSync(bad)
    writeFileSync(join(bad, 'buddy.md'), 'no header here')
    expect(store.list().map((b) => b.id)).toEqual(['good'])
    for (const id of ['../good', 'Good', 'a/b', 'a\\b', '', '-x', 'x-', 'a'.repeat(41), '..'])
      expect(isBuddyId(id)).toBe(false)
    expect(store.get('../good')).toBeNull()
    expect(store.remove('..')).toBe(false)
    expect(() => store.save({ ...store.get('good')!, id: '../evil' })).toThrow()
    expect(existsSync(join(root, '..', 'evil'))).toBe(false)
  })

  it('makes ids from names', () => {
    expect(buddyIdFor('Inbox Buddy!')).toBe('inbox-buddy')
    expect(buddyIdFor('Café Bot')).toBe('cafe-bot')
    expect(buddyIdFor('📬')).toBe('buddy')
    expect(isBuddyId(buddyIdFor('x'.repeat(80)))).toBe(true)
  })

  it('allows local folders only', () => {
    expect(folderAllowed('C:\\Users\\me\\Downloads')).toBe(true)
    expect(folderAllowed('C:\\')).toBe(false)
    expect(folderAllowed('\\\\?\\C:\\x')).toBe(false)
    expect(folderAllowed('\\\\server\\share\\x')).toBe(false)
    expect(folderAllowed('relative\\x')).toBe(false)
    expect(folderAllowed('C:\\a\\..\\b')).toBe(false)
  })

  it('a name that starts like a command ends in Buddy', () => {
    expect(store.create({ name: 'Send Email' }).name).toBe('Send Email Buddy')
    expect(clampBuddy('x', { name: 'open outlook' }).name).toBe('open outlook Buddy')
    expect(clampBuddy('x', { name: 'Send Buddy' }).name).toBe('Send Buddy')
    expect(clampBuddy('x', { name: 'Inbox Buddy' }).name).toBe('Inbox Buddy')
    expect(clampBuddy('x', { name: 'Openers' }).name).toBe('Openers')
    expect(clampBuddy('x', { name: 'Find ' + 'x'.repeat(40) }).name.length).toBeLessThanOrEqual(40)
  })

  it('refuses the profile root, system folders and app data', () => {
    for (const p of [
      'C:/Users',
      'C:\\Users\\sam',
      'C:\\Users\\sam\\',
      'C:\\Users\\sam\\AppData\\Roaming\\Lumen',
      'C:\\Users\\sam\\.ai-overlay',
      'C:\\Users\\sam\\.ssh',
      'C:\\Windows\\System32',
      'C:\\Program Files\\App',
      'C:\\ProgramData',
      'D:\\work\\AppData'
    ])
      expect(folderAllowed(p), p).toBe(false)
    expect(folderAllowed('C:\\Users\\sam\\Documents\\Invoices')).toBe(true)
    expect(folderAllowed('D:\\Photos')).toBe(true)
  })

  it('removes a buddy folder', () => {
    const b = store.create({ name: 'Gone Soon' })
    store.appendNotebook(b.id, 'a note')
    expect(store.remove(b.id)).toBe(true)
    expect(existsSync(join(root, b.id))).toBe(false)
  })
})

describe('buddy notebook', () => {
  it('appends dated lines and skips repeats', () => {
    const b = store.create({ name: 'Notes' })
    expect(store.appendNotebook(b.id, 'The boss is Ann.')).toBe('ok')
    expect(store.appendNotebook(b.id, 'The boss is Ann.')).toBe('ok')
    expect(store.readNotebook(b.id)).toBe('- 2026-10-02 The boss is Ann.\n')
  })

  it('keeps the newest lines under 8 KB', () => {
    const b = store.create({ name: 'Full' })
    for (let i = 0; i < 100; i++) store.appendNotebook(b.id, `note ${i} ${'x'.repeat(200)}`)
    const text = store.readNotebook(b.id)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(BUDDY_NOTEBOOK_MAX_BYTES)
    expect(text).toContain('note 99 ')
    expect(text).not.toContain('note 0 ')
    expect(capNotebook('a\nb', 1)).toBe('b')
  })

  it('writes nothing in private mode or with memory off', () => {
    const b = store.create({ name: 'Private' })
    writable = false
    expect(store.appendNotebook(b.id, 'secret plan')).toBe('disabled')
    expect(store.writeNotebook(b.id, 'edited')).toBe('disabled')
    expect(existsSync(join(root, b.id, 'memory.md'))).toBe(false)
  })

  it('refuses sensitive facts, a too-long edit and a missing buddy', () => {
    const b = store.create({ name: 'Careful' })
    expect(store.appendNotebook(b.id, 'my password is hunter2')).toBe('rejected')
    expect(store.writeNotebook(b.id, 'x'.repeat(BUDDY_NOTEBOOK_MAX_BYTES + 1))).toBe('too-long')
    expect(store.writeNotebook(b.id, 'line one\r\nline two')).toBe('ok')
    expect(store.readNotebook(b.id)).toBe('line one\nline two')
    expect(store.appendNotebook('nobody', 'x')).toBe('missing')
  })
})
