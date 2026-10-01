import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPacks, MARKER_FILE, NoPackError, PackError } from '../../src/main/packs/install'
import { skillPackKind } from '../../src/main/packs/skill-kind'
import { folderEntries, zip, type ZipEntry } from '../../src/main/packs/zip-write'
import {
  createSkill,
  deleteSkill,
  exportSkill,
  installArchive,
  previewArchive,
  saveSkillFiles,
  saveSkillText,
  takenNames
} from '../../src/main/skills/manage'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { skillMd, tempRoots, writeAppPack, writeSkill, type TempRoots } from './fixtures'

let r: TempRoots
let reg: SkillRegistry

beforeEach(() => {
  r = tempRoots()
  reg = new SkillRegistry(r, { state: new SkillStateStore(join(r.base, 'state.json')) }).load()
})
afterEach(() => r.cleanup())

const entries = (name: string, extra: Record<string, string> = {}): ZipEntry[] => [
  {
    name: `${name}/SKILL.md`,
    data: Buffer.from(skillMd(name, { extra: 'permissions:\n  input: true' }))
  },
  ...Object.entries(extra).map(([k, v]) => ({ name: `${name}/${k}`, data: Buffer.from(v) }))
]

describe('install / export', () => {
  it('previews permissions without writing anything', () => {
    const p = previewArchive(reg, zip(entries('shared', { 'reference/a.md': 'x' })))
    expect(p).toMatchObject({
      ok: true,
      skills: [{ name: 'shared', files: 2, updates: false, permissions: { input: true } }]
    })
    expect(readdirSync(r.user)).toEqual([])
  })

  it('round-trips export → import on a clean profile', () => {
    const src = writeSkill(r.user, 'my-skill', {
      files: {
        'reference/notes.md': 'Notes',
        'steps.json': '{"steps":[{"do":"keys","combo":"ctrl+s"}]}'
      }
    })
    reg.load()
    const out = exportSkill(reg, 'my-skill')
    if (!out.ok) throw new Error(out.error)

    const clean = tempRoots()
    try {
      const reg2 = new SkillRegistry(clean, {
        state: new SkillStateStore(join(clean.base, 'state.json'))
      }).load()
      const res = installArchive(reg2, out.data, 'my-skill.lumen')
      expect(res).toMatchObject({ ok: true, installed: [{ id: 'my-skill', updated: false }] })
      const s = reg2.get('my-skill')!
      expect(reg2.trustOf(s)).toBe('community-untrusted')
      expect(s.hasSteps).toBe(true)
      expect(readFileSync(join(clean.user, 'my-skill', 'reference', 'notes.md'), 'utf8')).toBe(
        'Notes'
      )
      expect(readFileSync(join(clean.user, 'my-skill', 'SKILL.md'), 'utf8')).toBe(
        readFileSync(join(src, 'SKILL.md'), 'utf8')
      )
      const marker = JSON.parse(readFileSync(join(clean.user, 'my-skill', MARKER_FILE), 'utf8'))
      expect(marker).toMatchObject({ kind: 'agent-skill', trust: 'community-untrusted' })
      // Installing again updates in place.
      expect(installArchive(reg2, out.data, 'again.lumen')).toMatchObject({
        ok: true,
        installed: [{ updated: true }]
      })
    } finally {
      clean.cleanup()
    }
  })

  it('rejects a zip-slip path before anything is written', () => {
    const bad = [...entries('evil'), { name: 'evil/../../escape.md', data: Buffer.from('x') }]
    const res = installArchive(reg, zip(bad), 'evil.lumen')
    expect(res.ok).toBe(false)
    expect(existsSync(join(r.user, 'evil'))).toBe(false)
    expect(existsSync(join(r.base, 'home', 'escape.md'))).toBe(false)
  })

  it('rejects scripts, bad SKILL.md and names that ship with Lumen', () => {
    expect(installArchive(reg, zip(entries('x', { 'run.ps1': 'evil' })), 'a')).toMatchObject({
      ok: false,
      problems: [expect.stringContaining('run.ps1')]
    })
    const broken = [{ name: 'y/SKILL.md', data: Buffer.from('---\nname: y\n---\n') }]
    expect(installArchive(reg, zip(broken), 'b').ok).toBe(false)
    // The archive folder name does not matter: the skill installs under its SKILL.md name.
    const renamed = [{ name: 'folder/SKILL.md', data: Buffer.from(skillMd('other')) }]
    expect(installArchive(reg, zip(renamed), 'c')).toMatchObject({
      ok: true,
      installed: [{ id: 'other' }]
    })

    writeSkill(r.builtin, 'clean-downloads')
    writeAppPack(r.appPacks, 'gimp')
    reg.load()
    expect(takenNames(reg)).toEqual(expect.arrayContaining(['clean-downloads', 'gimp']))
    for (const name of ['clean-downloads', 'gimp', 'schema'])
      expect(installArchive(reg, zip(entries(name)), 'd')).toMatchObject({ ok: false })
  })

  it('never replaces the user’s own skill', () => {
    writeSkill(r.user, 'mine')
    reg.load()
    const res = installArchive(reg, zip(entries('mine')), 'x.lumen')
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('your own') })
  })

  it('says when a file holds no skills (e.g. a lesson pack)', () => {
    const lessonPack = folderEntries(resolve(__dirname, '../../skills/gimp'), 'gimp')
    expect(previewArchive(reg, zip(lessonPack))).toEqual({
      ok: false,
      error: 'there are no skills in this file'
    })
  })

  it('a lesson pack and a skill with the same id never replace each other', () => {
    const kind = skillPackKind({
      schemaDir: resolve(__dirname, '../../skills/schema'),
      bundledIds: () => []
    })
    expect(installArchive(reg, zip(entries('gimp')), 's.lumen').ok).toBe(true)
    const gimp = folderEntries(resolve(__dirname, '../../skills/gimp'), 'gimp')
    expect(() => installPacks(zip(gimp), { kind, destRoot: r.user, source: 'gimp.lumen' })).toThrow(
      /different kind/
    )
    expect(() =>
      installPacks(zip(entries('only-skill')), { kind, destRoot: r.user, source: 'x' })
    ).toThrow(NoPackError)
    expect(new NoPackError('x')).toBeInstanceOf(PackError)
  })
})

describe('create / edit / delete', () => {
  it('creates from the template and refuses clashes', () => {
    expect(createSkill(reg, 'tidy-desktop', 'Tidies the desktop.')).toEqual({
      ok: true,
      name: 'tidy-desktop'
    })
    expect(reg.get('tidy-desktop')?.manifest.description).toBe('Tidies the desktop.')
    expect(createSkill(reg, 'tidy-desktop', '').ok).toBe(false)
    expect(createSkill(reg, 'Bad Name', '').ok).toBe(false)
    expect(createSkill(reg, '..', '').ok).toBe(false)
    expect(createSkill(reg, 'user', '').ok).toBe(false)
  })

  it('edits a user skill in place and keeps the name', () => {
    writeSkill(r.user, 'mine')
    reg.load()
    expect(saveSkillText(reg, 'mine', skillMd('mine', { body: 'New body' }))).toEqual({ ok: true })
    expect(reg.body('mine')).toBe('New body')
    expect(saveSkillText(reg, 'mine', skillMd('renamed')).ok).toBe(false)
    expect(saveSkillText(reg, 'mine', 'not a skill').ok).toBe(false)
  })

  it('editing a builtin skill saves a copy that overrides it', () => {
    writeSkill(r.builtin, 'clean-downloads', { files: { 'reference/c.md': 'table' } })
    reg.load()
    const res = saveSkillText(
      reg,
      'clean-downloads',
      skillMd('clean-downloads', { body: 'Mine now' })
    )
    expect(res).toEqual({ ok: true })
    const s = reg.get('clean-downloads')!
    expect(s.origin).toBe('user')
    expect(s.overrides).toBe('builtin')
    expect(readFileSync(join(r.user, 'clean-downloads', 'reference', 'c.md'), 'utf8')).toBe('table')
    expect(readFileSync(join(r.builtin, 'clean-downloads', 'SKILL.md'), 'utf8')).not.toContain(
      'Mine now'
    )
  })

  it('editing a community app-pack skill keeps the copy untrusted', () => {
    const pack = writeAppPack(r.user, 'editor')
    const marker = {
      format: 1,
      kind: 'app-pack',
      id: 'editor',
      trust: 'community-untrusted',
      source: 'https://example.com/editor.lumen',
      sha256: 'ab',
      installedAt: '2026-01-01T00:00:00.000Z'
    }
    writeFileSync(join(pack, MARKER_FILE), JSON.stringify(marker))
    writeSkill(join(pack, 'skills'), 'export-video')
    reg.load()
    expect(reg.trustOf(reg.get('export-video')!)).toBe('community-untrusted')
    expect(saveSkillFiles(reg, 'export-video', { skillMd: skillMd('export-video') })).toEqual({
      ok: true
    })
    reg.load()
    const s = reg.get('export-video')!
    expect(s.origin).toBe('user')
    expect(reg.trustOf(s)).toBe('community-untrusted')
    expect(s.source).toMatch(/edited copy of https:\/\/example\.com\/editor\.lumen/)
    // The copy can still be deleted like an installed skill.
    expect(deleteSkill(reg, 'export-video')).toEqual({ ok: true })
    expect(existsSync(join(r.user, 'export-video'))).toBe(false)
  })

  it('deletes user and installed skills, never builtin ones', () => {
    writeSkill(r.builtin, 'builtin-one')
    writeSkill(r.user, 'mine')
    reg.load()
    expect(installArchive(reg, zip(entries('shared')), 'x').ok).toBe(true)
    expect(deleteSkill(reg, 'builtin-one')).toMatchObject({ ok: false })
    expect(deleteSkill(reg, 'mine')).toEqual({ ok: true })
    expect(deleteSkill(reg, 'shared')).toEqual({ ok: true })
    expect(existsSync(join(r.user, 'mine'))).toBe(false)
    expect(existsSync(join(r.user, 'shared'))).toBe(false)
    expect(existsSync(join(r.builtin, 'builtin-one'))).toBe(true)
  })

  it('a user app-pack folder is never deleted as a skill', () => {
    const dir = writeAppPack(r.user, 'blender')
    writeFileSync(join(dir, 'SKILL.md'), skillMd('blender'))
    reg.load()
    expect(reg.get('blender')).toBeNull()
    expect(deleteSkill(reg, 'blender').ok).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })
})
