import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MARKER_FILE } from '../../src/main/packs/install'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { tempRoots, writeAppPack, writeSkill, type TempRoots } from './fixtures'

let r: TempRoots
let logs: string[]
let reg: SkillRegistry
let state: SkillStateStore

beforeEach(() => {
  r = tempRoots()
  logs = []
  state = new SkillStateStore(join(r.base, 'home', 'skills-state.json'))
  reg = new SkillRegistry(r, { state, log: (m) => logs.push(m) })
})
afterEach(() => {
  reg.unwatch()
  r.cleanup()
})

describe('SkillRegistry', () => {
  it('loads a valid skill without keeping its body', () => {
    writeSkill(r.builtin, 'tidy-desktop', { body: 'Secret body text.' })
    reg.load()
    const s = reg.get('tidy-desktop')!
    expect(s.manifest.description).toBe('Does the tidy-desktop thing.')
    expect(s.origin).toBe('builtin')
    expect(reg.trustOf(s)).toBe('builtin')
    expect(JSON.stringify(s)).not.toContain('Secret body text.')
    expect(reg.body('tidy-desktop')).toBe('Secret body text.')
    expect(reg.problems()).toEqual([])
  })

  it('skips bad frontmatter and lists the problem', () => {
    mkdirSync(join(r.user, 'broken'))
    writeFileSync(join(r.user, 'broken', 'SKILL.md'), '---\nname: broken\n---\nno description')
    writeSkill(r.user, 'fine')
    reg.load()
    expect(reg.all().map((s) => s.manifest.name)).toEqual(['fine'])
    expect(reg.problems()).toHaveLength(1)
    expect(reg.problems()[0].message).toMatch(/description/)
    expect(logs.some((l) => l.includes('broken'))).toBe(true)
  })

  it('rejects unknown permission keys', () => {
    writeSkill(r.user, 'greedy', { extra: 'permissions:\n  root: true' })
    reg.load()
    expect(reg.get('greedy')).toBeNull()
    expect(reg.problems()[0].message).toMatch(/root|unrecognized/i)
  })

  it('needs the name to match the folder', () => {
    writeSkill(r.user, 'one', { folder: 'two' })
    reg.load()
    expect(reg.all()).toEqual([])
    expect(reg.problems()[0].message).toMatch(/must match the folder/)
  })

  it('a user skill overrides the builtin one and the conflict is logged', () => {
    writeSkill(r.builtin, 'clean-downloads', { description: 'Builtin.' })
    writeSkill(r.user, 'clean-downloads', { description: 'Mine.' })
    reg.load()
    const s = reg.get('clean-downloads')!
    expect(s.manifest.description).toBe('Mine.')
    expect(s.origin).toBe('user')
    expect(s.overrides).toBe('builtin')
    expect(reg.trustOf(s)).toBe('mine')
    expect(reg.conflicts()).toHaveLength(1)
    expect(logs.some((l) => /clean-downloads.*replaces/.test(l))).toBe(true)
  })

  it('loads app-pack skills between builtin and user, and skips app-pack folders as skills', () => {
    const resolve = writeAppPack(r.appPacks, 'davinci-resolve')
    writeSkill(join(resolve, 'skills'), 'export-for-youtube', { description: 'Resolve.' })
    writeSkill(r.builtin, 'export-for-youtube', { description: 'Builtin.' })
    // An installed app pack in the user folder is not a skill itself.
    writeAppPack(r.user, 'gimp')
    reg.load()
    const s = reg.get('export-for-youtube')!
    expect(s.manifest.description).toBe('Resolve.')
    expect(s.origin).toBe('app-pack')
    expect(s.overrides).toBe('builtin')
    expect(reg.get('gimp')).toBeNull()
    expect(reg.problems()).toEqual([])
  })

  it('marks installed skills community-untrusted until the user trusts them', () => {
    const dir = writeSkill(r.user, 'shared')
    writeFileSync(
      join(dir, MARKER_FILE),
      JSON.stringify({
        format: 1,
        kind: 'agent-skill',
        id: 'shared',
        trust: 'community-untrusted',
        source: 'x.lumen'
      })
    )
    reg.load()
    const s = reg.get('shared')!
    expect(reg.trustOf(s)).toBe('community-untrusted')
    expect(reg.summary(s).source).toBe('x.lumen')
    state.setTrusted('shared', true)
    expect(reg.trustOf(s)).toBe('community-trusted')
  })

  it('switches skills off and keeps the setting across a reload', () => {
    writeSkill(r.user, 'a')
    writeSkill(r.user, 'b')
    reg.load()
    state.setEnabled('a', false)
    const again = new SkillRegistry(r, {
      state: new SkillStateStore(join(r.base, 'home', 'skills-state.json'))
    }).load()
    expect(again.enabled().map((s) => s.manifest.name)).toEqual(['b'])
    expect(again.summary(again.get('a')!).enabled).toBe(false)
  })

  it('reloads when the user folder changes', async () => {
    reg.load()
    reg.watch(50)
    let changed = 0
    reg.onChange(() => changed++)
    writeSkill(r.user, 'fresh')
    const deadline = Date.now() + 4000
    while (!reg.get('fresh') && Date.now() < deadline)
      await new Promise((res) => setTimeout(res, 50))
    expect(reg.get('fresh')).not.toBeNull()
    expect(changed).toBeGreaterThan(0)
  })
})
