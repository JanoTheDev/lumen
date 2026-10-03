// Parsed buddies are reused until buddy.md or the import marker changes; every write path and
// a hand edit are seen on the next read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readFileSync = vi.fn(actual.readFileSync)
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  utimesSync,
  writeFileSync,
  mkdirSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BuddyStore, IMPORT_MARKER } from '../../src/main/buddies/store'
import { BuddyVoice, type BuddyVoiceDeps } from '../../src/main/buddies/voice'

const reads = vi.mocked(readFileSync)
let root: string
let store: BuddyStore

const buddyReads = (): number =>
  reads.mock.calls.filter(([p]) => String(p).endsWith('buddy.md')).length

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lumen-buddies-cache-'))
  store = new BuddyStore(root, { now: () => Date.UTC(2026, 9, 2, 8) })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  reads.mockClear()
})

describe('buddy store cache', () => {
  it('reads each buddy.md once for two lists and again after save', () => {
    const a = store.create({ name: 'Inbox Buddy', instructions: 'Check mail.' })
    store.create({ name: 'Price Buddy', instructions: 'Watch prices.' })
    store = new BuddyStore(root, { now: () => Date.UTC(2026, 9, 2, 8) })
    reads.mockClear()
    const first = store.list()
    expect(buddyReads()).toBe(2)
    expect(store.list()).toEqual(first)
    expect(buddyReads()).toBe(2)

    store.save({ ...a, instructions: 'Check mail and calendar.' })
    reads.mockClear()
    const after = store.list()
    expect(after.find((b) => b.id === a.id)?.instructions).toBe('Check mail and calendar.')
    expect(buddyReads()).toBe(1)
  })

  it('hands out copies', () => {
    const a = store.create({ name: 'Inbox Buddy', instructions: 'Check mail.' })
    const got = store.get(a.id)!
    got.name = 'Changed'
    got.skills.push('x')
    expect(store.get(a.id)?.name).toBe('Inbox Buddy')
    expect(store.list()[0].skills).toEqual([])
  })

  it('sees a hand edit, a new folder, an import marker and a removed folder', () => {
    const a = store.create({ name: 'Inbox Buddy', instructions: 'Check mail.' })
    expect(store.get(a.id)?.trust).toBe('mine')
    const file = join(root, a.id, 'buddy.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Check mail.', 'Check post.'))
    expect(store.get(a.id)?.instructions).toBe('Check post.')
    // Same size, new time.
    writeFileSync(file, readFileSync(file, 'utf8').replace('Check post.', 'Check note.'))
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(store.get(a.id)?.instructions).toBe('Check note.')

    writeFileSync(join(root, a.id, IMPORT_MARKER), '{}')
    expect(store.get(a.id)?.trust).toBe('community-untrusted')

    // A folder put in place by another writer (a pack import renames a staged folder in).
    const other = new BuddyStore(join(root, '..', `${root.split(/[\\/]/).pop()}-stage`))
    const b = other.create({ name: 'Price Buddy', instructions: 'Watch prices.' })
    mkdirSync(root, { recursive: true })
    renameSync(join(other.root, b.id), join(root, b.id))
    rmSync(other.root, { recursive: true, force: true })
    expect(store.list().map((x) => x.name)).toEqual(['Inbox Buddy', 'Price Buddy'])

    rmSync(join(root, b.id), { recursive: true, force: true })
    expect(store.list().map((x) => x.name)).toEqual(['Inbox Buddy'])
    expect(store.remove(a.id)).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.get(a.id)).toBeNull()
  })

  it('does not keep a buddy.md it could not parse', () => {
    const a = store.create({ name: 'Inbox Buddy', instructions: 'Check mail.' })
    const file = join(root, a.id, 'buddy.md')
    const good = readFileSync(file, 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(file, '---\nname: [broken\n---\n')
    expect(store.get(a.id)).toBeNull()
    writeFileSync(file, good)
    expect(store.get(a.id)?.name).toBe('Inbox Buddy')
    warn.mockRestore()
  })

  it('a voice turn with 10 buddies reads no buddy.md on the second utterance', async () => {
    for (let i = 0; i < 10; i++) store.create({ name: `Helper ${i} Buddy`, instructions: 'Hi.' })
    store = new BuddyStore(root, { now: () => Date.UTC(2026, 9, 2, 8) })
    const deps: BuddyVoiceDeps = {
      list: () => store.list(),
      summaries: () => [],
      call: vi.fn(async () => ({ mode: 'answer' as const, text: 'ok', spoken: 'ok' })),
      stop: () => 0,
      stopAll: () => 0,
      setEnabled: () => true,
      pausedAll: () => false,
      setPausedAll: () => {},
      nextRunAt: () => undefined,
      lastRun: () => undefined,
      now: () => Date.UTC(2026, 9, 2, 8)
    }
    const v = new BuddyVoice(deps)
    reads.mockClear()
    expect(await v.turn("what's the weather")).toBeNull()
    expect(buddyReads()).toBe(10)
    reads.mockClear()
    expect(await v.turn('open my email')).toBeNull()
    expect(await v.turn('Helper 3 Buddy, check the news')).not.toBeNull()
    expect(buddyReads()).toBe(0)
    expect(deps.call).toHaveBeenCalledTimes(1)
  })
})
