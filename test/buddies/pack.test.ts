// Buddy `.lumen` packs (08 T51): export leaves the notebook, schedules and folders out; an import
// is community-untrusted, never replaces the user's own buddy and holds buddy.md only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
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
import { installPacks, PackError } from '../../src/main/packs/install'
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

  it("an import named like one of the user's buddies gets another name", () => {
    const b = makeInbox(new BuddyStore(home))
    makeInbox(new BuddyStore(away))
    const archive = exportBuddies([b])
    const plan = planBuddyArchive(archive, away)
    expect(plan[0].buddy.name).toBe('Inbox Buddy 2')
    expect(plan[0].notes.join(' ')).toMatch(/already have a buddy called Inbox Buddy/)
    expect(installBuddyArchive(archive, 'x.lumen', away)[0].name).toBe('Inbox Buddy 2')
    expect(new BuddyStore(away).get('inbox-buddy-2')!.name).toBe('Inbox Buddy 2')
    // Importing it again replaces that import; its own name does not count as taken.
    expect(planBuddyArchive(archive, away)[0].buddy.name).toBe('Inbox Buddy 2')
  })

  it('an import keeps no folders from the file', () => {
    const header = {
      tools: ['fetch_url', 'read_file'],
      network: ['https://evil.example.com'],
      files: { read: ['D:/Notes'], write: ['D:/Out'] }
    }
    const text = `---\nname: "Notes Buddy"\npermissions: ${JSON.stringify(header)}\n---\n\nRead.\n`
    const archive = zip([{ name: 'notes-buddy/buddy.md', data: Buffer.from(text) }])
    const plan = planBuddyArchive(archive, away)
    expect(plan[0].buddy.permissions.files).toEqual({ read: [], write: [] })
    expect(plan[0].notes.join(' ')).toMatch(/Folders in the file were left out \(D:\/Notes/)
    installBuddyArchive(archive, 'n.lumen', away)
    const b = new BuddyStore(away).get('notes-buddy')!
    expect(b.permissions.files).toEqual({ read: [], write: [] })
    expect(b.permissions.network).toEqual(['https://evil.example.com'])
    expect(b.trust).toBe('community-untrusted')
  })

  it('the pack file is rewritten before it is installed; a failed rewrite installs nothing (L2)', () => {
    const text = '---\nname: "Big Buddy"\nbudget: {"perRunUsd":5}\n---\n\nGo.\n'
    const archive = zip([{ name: 'big-buddy/buddy.md', data: Buffer.from(text) }])
    const seen: string[] = []
    const kind = buddyPackKind({
      rewrite: (dir, id) => {
        seen.push(id)
        expect(dir).not.toBe(join(away, id))
        throw new Error('disk full')
      }
    })
    expect(() => installPacks(archive, { kind, destRoot: away, source: 'b.lumen' })).toThrow(
      'disk full'
    )
    expect(seen).toEqual(['big-buddy'])
    expect(existsSync(join(away, 'big-buddy'))).toBe(false)
    // The real import: the installed file already holds the capped budget.
    installBuddyArchive(archive, 'b.lumen', away)
    expect(readFileSync(join(away, 'big-buddy', 'buddy.md'), 'utf8')).not.toContain('"perRunUsd":5')
  })

  it('an import keeps a budget per run no higher than the default', () => {
    const text = '---\nname: "Big Buddy"\nbudget: {"perRunUsd":5,"perMonthUsd":3}\n---\n\nGo.\n'
    const archive = zip([{ name: 'big-buddy/buddy.md', data: Buffer.from(text) }])
    const plan = planBuddyArchive(archive, away)
    expect(plan[0].buddy.budget).toEqual({ perRunUsd: 0.25, perMonthUsd: 3 })
    expect(plan[0].notes.join(' ')).toMatch(/lowered from \$5\.00 to \$0\.25/)
    installBuddyArchive(archive, 'b.lumen', away)
    expect(new BuddyStore(away).get('big-buddy')!.budget.perRunUsd).toBe(0.25)
  })

  it('an import keeps only connectors and skills that exist here', () => {
    const text = [
      '---',
      'name: "Mail Buddy"',
      'permissions: {"connectors":["gmail","their-server"]}',
      'skills: ["sum-up","x-skill"]',
      '---',
      '',
      'Go.',
      ''
    ].join('\n')
    const archive = zip([{ name: 'mail-buddy/buddy.md', data: Buffer.from(text) }])
    const known = { connectors: ['gmail'], skills: ['sum-up'] }
    const plan = planBuddyArchive(archive, away, known)
    expect(plan[0].buddy.permissions.connectors).toEqual(['gmail'])
    expect(plan[0].buddy.skills).toEqual(['sum-up'])
    expect(plan[0].notes.join(' ')).toMatch(/connectors that are not set up: their-server/)
    expect(plan[0].notes.join(' ')).toMatch(/skills that are not installed: x-skill/)
    installBuddyArchive(archive, 'm.lumen', away, known)
    expect(new BuddyStore(away).get('mail-buddy')!.permissions.connectors).toEqual(['gmail'])
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
