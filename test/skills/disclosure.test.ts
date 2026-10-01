import { mkdirSync, symlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSkillToolHandlers,
  fillParams,
  indexTruncated,
  listSkills,
  readSkillFile,
  skillIndexText,
  skillToolDefs,
  loadSkill
} from '../../src/main/skills/disclosure'
import { estimateTokens, parseSkillFile } from '../../src/main/skills/manifest'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { tempRoots, writeSkill, type TempRoots } from './fixtures'

let r: TempRoots
let reg: SkillRegistry
let state: SkillStateStore

beforeEach(() => {
  r = tempRoots()
  state = new SkillStateStore(join(r.base, 'state.json'))
  reg = new SkillRegistry(r, { state })
})
afterEach(() => r.cleanup())

const text = (o: { content: { text: string }[] }): string => o.content[0].text

describe('skillIndexText (L1)', () => {
  it('lists enabled skills alphabetically with when_to_use, and nothing else', () => {
    writeSkill(r.user, 'zeta', { body: 'BODY-Z' })
    writeSkill(r.user, 'alpha', { extra: 'when_to_use: the user says alpha' })
    writeSkill(r.user, 'off')
    reg.load()
    state.setEnabled('off', false)
    const t = skillIndexText(reg)
    const lines = t.split('\n')
    expect(lines.slice(1)).toEqual([
      '- alpha: Does the alpha thing. Use when: the user says alpha',
      '- zeta: Does the zeta thing.'
    ])
    expect(t).not.toContain('BODY-Z')
    expect(indexTruncated(reg)).toBe(false)
  })

  it('is empty without enabled skills', () => {
    reg.load()
    expect(skillIndexText(reg)).toBe('')
  })

  it('does not change when a body changes, nor with the foreground app when all fit', () => {
    const dir = writeSkill(r.user, 'a', { extra: 'apps: [gimp]' })
    writeSkill(r.user, 'b')
    reg.load()
    const before = skillIndexText(reg, { app: null })
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: a\ndescription: Does the a thing.\napps: [gimp]\n---\nA new body.'
    )
    reg.load()
    expect(skillIndexText(reg, { app: 'gimp' })).toBe(before)
  })

  it('caps at 40 skills, boosts the active app and points at list_skills', () => {
    for (let i = 0; i < 45; i++) writeSkill(r.user, `s${String(i).padStart(2, '0')}`)
    writeSkill(r.user, 'zz-gimp-only', { extra: 'apps: [gimp]' })
    reg.load()
    const t = skillIndexText(reg, { app: 'gimp' })
    const items = t.split('\n').filter((l) => l.startsWith('- '))
    expect(items).toHaveLength(40)
    expect(items[0]).toMatch(/^- zz-gimp-only:/)
    expect(t).toMatch(/\n6 more skills: call list_skills/)
    expect(indexTruncated(reg, { app: 'gimp' })).toBe(true)
    expect(skillToolDefs({ truncated: true }).map((d) => d.name)).toContain('list_skills')
    expect(skillToolDefs().map((d) => d.name)).toEqual(['use_skill', 'read_skill_file'])
  })

  it('stays within the token budget', () => {
    for (let i = 0; i < 30; i++) writeSkill(r.user, `long-${i}`, { description: 'x'.repeat(190) })
    reg.load()
    const t = skillIndexText(reg)
    expect(estimateTokens(t)).toBeLessThanOrEqual(1500)
    expect(t).toMatch(/more skills: call list_skills/)
  })
})

describe('use_skill (L2)', () => {
  const extra = `params:
  tone: { type: string, default: polite, enum: [polite, formal] }
  count: { type: number }
permissions:
  input: true
  risky: true`

  it('returns the body with params filled, missing values, permissions and files', () => {
    writeSkill(r.user, 'reply', {
      extra,
      body: 'Write a {tone} reply in {count} lines. Keep {literal} braces.',
      files: { 'reference/tones.md': '# tones', '.hidden': 'x' }
    })
    reg.load()
    const out = loadSkill(reg, { name: 'reply' })
    expect(out.isError).toBeUndefined()
    const t = text(out)
    expect(t).toContain('<skill name="reply" version="1.0.0" trust="mine">')
    expect(t).toContain('Write a polite reply in {count} lines. Keep {literal} braces.')
    expect(t).toContain('Missing values (ask the user before starting): count.')
    expect(t).toMatch(/may use the mouse and keyboard.*Every action needs/)
    expect(t).toContain('- reference/tones.md (7 B)')
    expect(t).not.toContain('.hidden')
  })

  it('takes args as pairs or an object and checks them', () => {
    writeSkill(r.user, 'reply', { extra, body: '{tone} {count}' })
    reg.load()
    expect(
      text(
        loadSkill(reg, {
          name: 'reply',
          args: [
            { name: 'tone', value: 'formal' },
            { name: 'count', value: '3' }
          ]
        })
      )
    ).toContain('formal 3')
    expect(text(loadSkill(reg, { name: 'reply', args: { tone: 'formal', count: 2 } }))).toContain(
      'formal 2'
    )
    const bad = loadSkill(reg, { name: 'reply', args: { tone: 'rude', count: 'x', other: 1 } })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(
      /tone must be one of.*count must be a number.*unknown parameter "other"/
    )
  })

  it('refuses disabled and unknown skills', () => {
    writeSkill(r.user, 'off')
    reg.load()
    state.setEnabled('off', false)
    expect(loadSkill(reg, { name: 'off' }).isError).toBe(true)
    expect(loadSkill(reg, { name: 'nope' }).isError).toBe(true)
  })

  it('reads the body fresh each time (lazy)', () => {
    const dir = writeSkill(r.user, 'a', { body: 'old' })
    reg.load()
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: a\ndescription: d\n---\nnew')
    expect(text(loadSkill(reg, { name: 'a' }))).toContain('new')
  })

  it('fillParams leaves undeclared placeholders alone', () => {
    const { manifest } = parseSkillFile('---\nname: a\ndescription: d\n---\nx')
    expect(fillParams('{x} {y}', manifest, undefined).text).toBe('{x} {y}')
  })
})

describe('read_skill_file (L3)', () => {
  beforeEach(() => {
    writeSkill(r.user, 'docs', {
      files: {
        'reference/a.md': 'Alpha notes',
        'img.png': 'PNG',
        'big.txt': 'x'.repeat(64 * 1024 + 1),
        'bin.txt': 'a\0b'
      }
    })
    writeFileSync(join(r.user, 'secret.md'), 'outside')
    reg.load()
  })

  it('reads a text file inside the skill', () => {
    const out = readSkillFile(reg, { name: 'docs', path: 'reference/a.md' })
    expect(out.isError).toBeUndefined()
    expect(text(out)).toContain('Alpha notes')
    expect(text(readSkillFile(reg, { name: 'docs', path: 'reference\\a.md' }))).toContain('Alpha')
  })

  it.each([
    ['../secret.md', '".." is not allowed'],
    ['reference/../../secret.md', '".." is not allowed'],
    [resolve('/etc/passwd'), 'absolute'],
    ['C:/Windows/win.ini', 'absolute'],
    ['/secret.md', 'absolute'],
    ['.lumen-pack.json', 'hidden'],
    ['img.png', 'only text files'],
    ['big.txt', 'larger than 64 KB'],
    ['bin.txt', 'not a text file'],
    ['missing.md', 'No file']
  ])('rejects %s', (path, msg) => {
    const out = readSkillFile(reg, { name: 'docs', path })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain(msg)
  })

  it('rejects a link that points out of the skill', () => {
    const outside = join(r.base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'x.md'), 'escaped')
    try {
      symlinkSync(outside, join(r.user, 'docs', 'link'), 'junction')
    } catch {
      return // no permission to make links here
    }
    const out = readSkillFile(reg, { name: 'docs', path: 'link/x.md' })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('outside the skill')
  })
})

describe('list_skills + handlers', () => {
  it('searches names, descriptions and triggers', async () => {
    writeSkill(r.user, 'clean-downloads', { extra: 'triggers: ["tidy my downloads"]' })
    writeSkill(r.user, 'reply')
    reg.load()
    expect(text(listSkills(reg, { query: 'tidy' }))).toMatch(/^- clean-downloads:/)
    expect(text(listSkills(reg, { query: 'nothing here' }))).toBe('No matching skills.')
    const h = createSkillToolHandlers(reg)
    expect(text(await h.list_skills({}))).toContain('- reply:')
    expect((await h.use_skill({ name: 42 })).isError).toBe(true)
    expect(text(await h.use_skill({ name: 'reply' }))).toContain('Steps for reply.')
  })

  it('honours an allow filter (background tool sets)', () => {
    writeSkill(r.user, 'a')
    reg.load()
    expect(loadSkill(reg, { name: 'a' }, { allow: () => false }).isError).toBe(true)
  })
})
