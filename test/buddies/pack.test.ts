// Buddy `.lumen` packs (08 T51): export leaves the notebook, schedules and folders out; an import
// is community-untrusted, never replaces the user's own buddy and holds buddy.md only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Buddy } from '@shared/buddies'
import { BuddyStore, IMPORT_MARKER } from '../../src/main/buddies/store'
import {
  buddyPackKind,
  exportBuddies,
  installBuddyArchive,
  planBuddyArchive
} from '../../src/main/packs/buddy-kind'
import { PackError } from '../../src/main/packs/install'
import { readZip } from '../../src/main/packs/zip-read'
import { zip } from '../../src/main/packs/zip-write'

let home: string
let away: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lumen-buddy-pack-a-'))
  away = mkdtempSync(join(tmpdir(), 'lumen-buddy-pack-b-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(away, { recursive: true, force: true })
})

function makeInbox(store: BuddyStore): Buddy {
  const b = store.create({
    name: 'Inbox Buddy',
    instructions: 'Sums up new mail.',
    permissions: {
      tools: ['fetch_url', 'read_file'],
      apps: [],
      input: false,
      network: ['https://mail.example.com'],
      files: { read: ['C:\\Users\\sam\\Documents'], write: [] },
      connectors: ['gmail']
    },
    scheduleIds: ['auto_1'],
    model: 'main'
  })
  store.appendNotebook(b.id, 'the boss is Kim')
  return b
}

describe('buddy packs', () => {
  it('round-trips without anything private and installs untrusted', () => {
    const mine = new BuddyStore(home)
    const b = makeInbox(mine)
    const archive = exportBuddies([b])
    const names = readZip(archive).map((f) => f.name)
    expect(names).toEqual(['inbox-buddy/buddy.md'])
    const text = readZip(archive)[0].data.toString('utf8')
    expect(text).not.toContain('Kim')
    expect(text).not.toContain('auto_1')
    expect(text).not.toContain('Documents')

    const plan = planBuddyArchive(archive, away)
    expect(plan.map((p) => [p.id, p.buddy.name, p.updates])).toEqual([
      ['inbox-buddy', 'Inbox Buddy', false]
    ])
    const done = installBuddyArchive(archive, 'inbox.lumen', away)
    expect(done).toEqual([{ id: 'inbox-buddy', name: 'Inbox Buddy', updated: false }])
    expect(existsSync(join(away, 'inbox-buddy', IMPORT_MARKER))).toBe(true)
    const theirs = new BuddyStore(away).get('inbox-buddy')!
    expect(theirs.trust).toBe('community-untrusted')
    expect(theirs.scheduleIds).toEqual([])
    expect(theirs.permissions.files.read).toEqual([])
    expect(theirs.permissions.connectors).toEqual(['gmail'])
    expect(theirs.model).toBe('main')
    expect(new BuddyStore(away).readNotebook('inbox-buddy')).toBe('')

    // A second import of the same buddy replaces the earlier import.
    expect(planBuddyArchive(archive, away)[0].updates).toBe(true)
    expect(installBuddyArchive(archive, 'inbox.lumen', away)[0].updated).toBe(true)
  })

  it('never replaces the user own buddy of that name', () => {
    const b = makeInbox(new BuddyStore(home))
    makeInbox(new BuddyStore(away))
    const done = installBuddyArchive(exportBuddies([b]), 'x.lumen', away)
    expect(done[0].id).toBe('inbox-buddy-2')
    expect(new BuddyStore(away).get('inbox-buddy')!.trust).toBe('mine')
    expect(new BuddyStore(away).get('inbox-buddy-2')!.trust).toBe('community-untrusted')
  })

  it('a trust line in the file does not make it trusted', () => {
    const text = '---\nname: "Sneaky Buddy"\ntrust: "mine"\n---\n\nDo things.\n'
    const archive = zip([{ name: 'sneaky-buddy/buddy.md', data: Buffer.from(text) }])
    installBuddyArchive(archive, 's.lumen', away)
    expect(new BuddyStore(away).get('sneaky-buddy')!.trust).toBe('community-untrusted')
  })

  it('refuses a notebook, scripts or a buddy without a name, and changes nothing', () => {
    const md = '---\nname: "Inbox Buddy"\n---\n\nHi.\n'
    const bad = [
      zip([
        { name: 'inbox-buddy/buddy.md', data: Buffer.from(md) },
        { name: 'inbox-buddy/memory.md', data: Buffer.from('secret notes') }
      ]),
      zip([
        { name: 'inbox-buddy/buddy.md', data: Buffer.from(md) },
        { name: 'inbox-buddy/run.ps1', data: Buffer.from('evil') }
      ]),
      zip([{ name: 'x/buddy.md', data: Buffer.from('---\nmodel: "fast"\n---\n\nHi.\n') }])
    ]
    for (const a of bad) expect(() => installBuddyArchive(a, 'bad.lumen', away)).toThrow(PackError)
    expect(readdirSync(away)).toEqual([])
  })

  it('the kind names its id from the buddy name', () => {
    const kind = buddyPackKind()
    expect(kind.idOf(Buffer.from('---\nname: "Price Buddy!"\n---\n\nx\n'))).toBe('price-buddy')
    expect(kind.reserved('Bad Id')).toMatch(/not a buddy name/)
  })
})
