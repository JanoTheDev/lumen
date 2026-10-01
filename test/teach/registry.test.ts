import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillRegistry } from '../../src/main/teach/registry'

const BUILTIN = join(__dirname, '..', '..', 'skills')

describe('SkillRegistry on the shipped packs', () => {
  const reg = new SkillRegistry({ builtin: BUILTIN }).load()

  it('loads every pack and lesson without problems', () => {
    expect(reg.problems()).toEqual([])
    expect(reg.all().length).toBeGreaterThanOrEqual(10)
    for (const s of reg.all()) expect(s.lessons.length).toBeGreaterThan(0)
  })

  it('matches Blender by its process name', () => {
    expect(
      reg.matchApp({ process: 'C:\\Program Files\\Blender\\blender.exe', title: '' })?.id
    ).toBe('blender')
  })

  it('matches Figma in a browser by url', () => {
    const win = {
      process: 'chrome.exe',
      title: 'Untitled',
      url: 'https://www.figma.com/design/abc/x'
    }
    expect(reg.matchApp(win)?.id).toBe('figma')
  })

  it('matches Windows Settings by SystemSettings.exe', () => {
    expect(reg.matchApp({ process: 'SystemSettings.exe', title: 'Settings' })?.id).toBe('windows')
  })

  it('returns null for an unknown app', () => {
    expect(reg.matchApp({ process: 'notepad.exe', title: 'notes.txt - Notepad' })).toBeNull()
    expect(reg.matchApp(null)).toBeNull()
  })

  it('normalizes bare and missing expects into checks', () => {
    const found = reg.lesson('windows-basics-01-display-scaling')
    expect(found?.skill.id).toBe('windows')
    const steps = found!.lesson.steps
    expect(steps[0].check.type).toBe('anyOf')
    expect(steps[steps.length - 1].check).toEqual({ type: 'manual' })
  })
})

const LESSON = (id: string, app: string, title: string): object => ({
  id,
  app,
  title,
  level: 'beginner',
  minutes: 2,
  prereqs: [],
  appVersion: '>=1',
  steps: [
    { id: 'one', say: 'Do the first thing.', target: null, hints: ['Hint one.'], why: 'Because.' },
    {
      id: 'two',
      say: 'Do the second thing.',
      target: { shortcut: 'Ctrl+S' },
      expect: { type: 'user-action', check: 'keypress' },
      hints: ['Hint two.'],
      why: 'Because.'
    }
  ]
})

function writePack(root: string, id: string, manifest: object | null, lessons: object[]): void {
  const dir = join(root, id)
  mkdirSync(join(dir, 'lessons'), { recursive: true })
  if (manifest) writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest))
  for (const l of lessons)
    writeFileSync(
      join(dir, 'lessons', `${(l as { id: string }).id}.lesson.json`),
      JSON.stringify(l)
    )
}

const manifest = (id: string, name: string, process: string): object => ({
  id,
  name,
  version: '1.0.0',
  match: { process: [process] },
  uiaQuality: 'none',
  appVersion: '>=1',
  appVersionTested: '1',
  lastVerified: '2026-10-01'
})

describe('SkillRegistry with user packs', () => {
  let root: string
  let builtin: string
  let user: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lumen-reg-'))
    builtin = join(root, 'builtin')
    user = join(root, 'user')
    writePack(builtin, 'tool', manifest('tool', 'Tool', 'tool.exe'), [
      LESSON('tool-basics-01-start', 'tool', 'Bundled start'),
      LESSON('tool-basics-02-save', 'tool', 'Bundled save')
    ])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a user pack with the same id overrides the manifest and lessons it redefines', () => {
    writePack(user, 'tool', manifest('tool', 'My Tool', 'mytool.exe'), [
      LESSON('tool-basics-01-start', 'tool', 'User start')
    ])
    const reg = new SkillRegistry({ builtin, user }).load()
    const skill = reg.get('tool')!
    expect(skill.name).toBe('My Tool')
    expect(skill.source).toBe('user')
    expect(reg.matchApp({ process: 'mytool.exe' })?.id).toBe('tool')
    expect(reg.matchApp({ process: 'tool.exe' })).toBeNull()
    expect(skill.lessons.map((l) => l.title)).toEqual(['User start', 'Bundled save'])
  })

  it('a lessons-only user folder adds lessons to the bundled pack', () => {
    writePack(user, 'tool', null, [LESSON('tool-extra-01-more', 'tool', 'Extra')])
    const reg = new SkillRegistry({ builtin, user }).load()
    expect(reg.get('tool')!.source).toBe('builtin')
    expect(reg.get('tool')!.lessons).toHaveLength(3)
  })

  it('loose user lessons attach to their app pack', () => {
    const dir = join(user, 'user', 'lessons')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tool-mine-01-x.lesson.json'),
      JSON.stringify(LESSON('tool-mine-01-x', 'tool', 'Mine'))
    )
    const reg = new SkillRegistry({ builtin, user }).load()
    expect(reg.lesson('tool-mine-01-x')?.skill.id).toBe('tool')
  })

  it('skips broken files and reports them', () => {
    writePack(user, 'bad', { id: 'bad' }, [])
    writePack(builtin, 'tool2', manifest('tool2', 'Tool 2', 't2.exe'), [
      { ...LESSON('tool2-basics-01-x', 'tool2', 'X'), steps: [] }
    ])
    const reg = new SkillRegistry({ builtin, user }).load()
    expect(reg.get('bad')).toBeNull()
    expect(reg.get('tool2')!.lessons).toEqual([])
    expect(reg.problems().map((p) => p.file.split(/[\\/]/).pop())).toEqual([
      'tool2-basics-01-x.lesson.json',
      'skill.json'
    ])
  })

  it('derives a keypress check from a bare expect and the shortcut target', () => {
    const reg = new SkillRegistry({ builtin }).load()
    const step = reg.lesson('tool-basics-01-start')!.lesson.steps[1]
    expect(step.check).toEqual({ type: 'keypress', combo: 'Ctrl+S' })
  })
})
