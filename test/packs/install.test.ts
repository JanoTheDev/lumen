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
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exportPacks,
  installedPacks,
  installPacks,
  MARKER_FILE,
  PackError,
  removePack
} from '../../src/main/packs/install'
import { skillPackKind } from '../../src/main/packs/skill-kind'
import { folderEntries, zip, type ZipEntry } from '../../src/main/packs/zip-write'
import { SkillRegistry } from '../../src/main/teach/registry'

const SKILLS = resolve(__dirname, '../../skills')
const kind = skillPackKind({ schemaDir: join(SKILLS, 'schema'), bundledIds: () => ['windows'] })

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lumen-packs-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const gimp = (prefix = 'gimp'): ZipEntry[] => folderEntries(join(SKILLS, 'gimp'), prefix)
const install = (entries: ZipEntry[], extra = {}): ReturnType<typeof installPacks> =>
  installPacks(zip(entries), { kind, destRoot: root, source: 'test.lumen', ...extra })

function problemsOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(PackError)
    return [(e as PackError).message, ...(e as PackError).problems]
  }
  throw new Error('expected a PackError')
}

describe('installPacks (skill packs)', () => {
  it('installs a valid pack with an untrusted marker', () => {
    const out = install(gimp())
    expect(out).toEqual([{ id: 'gimp', dir: join(root, 'gimp'), updated: false }])
    const marker = JSON.parse(readFileSync(join(root, 'gimp', MARKER_FILE), 'utf8'))
    expect(marker).toMatchObject({ id: 'gimp', kind: 'skill', trust: 'community-untrusted' })
    expect(installedPacks(root, 'skill').map((p) => p.id)).toEqual(['gimp'])
    // No staging folder is left behind.
    expect(readdirSync(root)).toEqual(['gimp'])
  })

  it('loads as an untrusted pack without "do it for me"', () => {
    install(gimp())
    const reg = new SkillRegistry({ builtin: join(root, 'none'), user: root }).load()
    const skill = reg.get('gimp')!
    expect(skill.trust).toBe('community-untrusted')
    expect(skill.lessons.length).toBeGreaterThan(0)
    expect(skill.lessons.flatMap((l) => l.steps).some((s) => s.doItForMe)).toBe(false)
  })

  it('finds a pack inside a repo zip, and a sub folder of it', () => {
    const repo = [
      { name: 'packs-main/README.md', data: Buffer.from('# hi') },
      ...gimp('packs-main/gimp')
    ]
    expect(install(repo).map((p) => p.id)).toEqual(['gimp'])
    rmSync(join(root, 'gimp'), { recursive: true })
    const nested = gimp('packs-main/apps/gimp')
    expect(install(nested, { subpath: 'apps' }).map((p) => p.id)).toEqual(['gimp'])
  })

  it('updates an earlier install of the same pack', () => {
    install(gimp())
    expect(install(gimp())[0].updated).toBe(true)
  })

  it('never replaces the user’s own pack', () => {
    mkdirSync(join(root, 'gimp'))
    writeFileSync(join(root, 'gimp', 'skill.json'), '{}')
    expect(problemsOf(() => install(gimp()))[0]).toMatch(/your own pack/)
    expect(readFileSync(join(root, 'gimp', 'skill.json'), 'utf8')).toBe('{}')
  })

  it('refuses a bundled or reserved id', () => {
    const entries = gimp().map((e) =>
      e.name === 'gimp/skill.json'
        ? { ...e, data: Buffer.from(e.data.toString().replace('"gimp"', '"windows"')) }
        : e
    )
    expect(problemsOf(() => install(entries)).join('\n')).toMatch(/ships with Lumen/)
  })

  it('rejects scripts and executables (data only)', () => {
    const entries = [...gimp(), { name: 'gimp/run.ps1', data: Buffer.from('evil') }]
    expect(problemsOf(() => install(entries)).join('\n')).toMatch(/data only.*run\.ps1/)
    expect(existsSync(join(root, 'gimp'))).toBe(false)
  })

  it('rejects an invalid pack with the validator’s problems and installs nothing', () => {
    const entries = gimp().map((e) =>
      e.name.endsWith('01-crop-scale.lesson.json') ? { ...e, data: Buffer.from('{"id":') } : e
    )
    const problems = problemsOf(() => install(entries))
    expect(problems.join('\n')).toMatch(/invalid JSON/)
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects zip-slip paths before anything is written', () => {
    const entries = [...gimp(), { name: 'gimp/../../evil.json', data: Buffer.from('{}') }]
    expect(problemsOf(() => install(entries))[0]).toMatch(/not a usable pack file/)
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects an archive with no pack and packs inside packs', () => {
    expect(problemsOf(() => install([{ name: 'a.md', data: Buffer.from('x') }]))[0]).toMatch(
      /no skill pack/
    )
    expect(problemsOf(() => install([...gimp(), ...gimp('gimp/inner')]))[0]).toMatch(
      /inside another/
    )
  })

  it('removes only marked packs', () => {
    install(gimp())
    mkdirSync(join(root, 'mine'))
    expect(removePack(root, 'mine')).toBe(false)
    expect(removePack(root, '../x')).toBe(false)
    expect(removePack(root, 'gimp')).toBe(true)
    expect(existsSync(join(root, 'gimp'))).toBe(false)
    expect(existsSync(join(root, 'mine'))).toBe(true)
  })

  it('exports a pack that installs again (round trip)', () => {
    install(gimp())
    const archive = exportPacks([join(root, 'gimp')], kind)
    const other = mkdtempSync(join(tmpdir(), 'lumen-packs-'))
    try {
      const out = installPacks(archive, { kind, destRoot: other, source: 'gimp.lumen' })
      expect(out.map((p) => p.id)).toEqual(['gimp'])
      // The marker is not exported; the new install writes its own.
      expect(readdirSync(join(other, 'gimp')).sort()).toEqual(
        [...readdirSync(join(SKILLS, 'gimp')), MARKER_FILE].sort()
      )
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
