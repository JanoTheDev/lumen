import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MARKER_FILE } from '../../src/main/packs/install'
import { skillIndexText } from '../../src/main/skills/disclosure'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { matchSkillTrigger } from '../../src/main/skills/triggers'
import { tempRoots, writeSkill, type TempRoots } from './fixtures'

let r: TempRoots
let state: SkillStateStore
let reg: SkillRegistry

beforeEach(() => {
  r = tempRoots()
  state = new SkillStateStore(join(r.base, 'state.json'))
  writeSkill(r.user, 'clean-downloads', {
    description: 'Sorts the Downloads folder.',
    extra: 'triggers: ["clean my downloads"]'
  })
  writeSkill(r.user, 'weekly-report', { description: 'Builds the weekly report.' })
  reg = new SkillRegistry(r, { state }).load()
})
afterEach(() => r.cleanup())

describe('cached skill index and triggers', () => {
  it('returns the same string for repeated calls', () => {
    const a = skillIndexText(reg)
    expect(skillIndexText(reg)).toBe(a)
    expect(skillIndexText(reg, { app: 'excel' })).toBe(a)
  })

  it('changes the index when a skill is switched off and back on', () => {
    const before = skillIndexText(reg)
    expect(before).toContain('- clean-downloads:')
    state.setEnabled('clean-downloads', false)
    const off = skillIndexText(reg)
    expect(off).not.toContain('- clean-downloads:')
    expect(off).toContain('- weekly-report:')
    expect(reg.enabled().map((s) => s.manifest.name)).toEqual(['weekly-report'])
    state.setEnabled('clean-downloads', true)
    expect(skillIndexText(reg)).toBe(before)
  })

  it('follows on/off for trigger phrases', () => {
    expect(matchSkillTrigger('clean my downloads', reg)).toMatchObject({ name: 'clean-downloads' })
    state.setEnabled('clean-downloads', false)
    expect(matchSkillTrigger('clean my downloads', reg)).toBeNull()
    state.setEnabled('clean-downloads', true)
    expect(matchSkillTrigger('clean my downloads', reg)).toMatchObject({ name: 'clean-downloads' })
  })

  it('picks up skills added, edited or deleted on the next load', () => {
    skillIndexText(reg)
    matchSkillTrigger('make the invoice', reg)
    writeSkill(r.user, 'invoice-maker', {
      description: 'Writes an invoice.',
      extra: 'triggers: ["make the invoice"]'
    })
    expect(skillIndexText(reg)).not.toContain('invoice-maker')
    reg.reload()
    expect(skillIndexText(reg)).toContain('- invoice-maker: Writes an invoice.')
    expect(matchSkillTrigger('make the invoice', reg)).toMatchObject({ name: 'invoice-maker' })
    writeSkill(r.user, 'invoice-maker', {
      description: 'Writes a nicer invoice.',
      extra: 'triggers: ["bill the client"]'
    })
    reg.load()
    expect(skillIndexText(reg)).toContain('- invoice-maker: Writes a nicer invoice.')
    expect(matchSkillTrigger('make the invoice', reg)).toBeNull()
    expect(matchSkillTrigger('bill the client', reg)).toMatchObject({ name: 'invoice-maker' })
  })

  it('changes the index when a community skill is trusted', () => {
    const dir = writeSkill(r.user, 'shared-tool', { description: 'A shared tool.' })
    writeFileSync(
      join(dir, MARKER_FILE),
      JSON.stringify({
        format: 1,
        kind: 'agent-skill',
        id: 'shared-tool',
        trust: 'community-untrusted',
        source: 'pack.lumen'
      })
    )
    reg.load()
    const untrusted = skillIndexText(reg)
    expect(untrusted).toContain('- shared-tool (untrusted):')
    const s = reg.get('shared-tool')!
    state.setTrusted('shared-tool', true, s.pin)
    expect(reg.trustOf(s)).toBe('community-trusted')
    const trusted = skillIndexText(reg)
    expect(trusted).toContain('- shared-tool: A shared tool.')
    state.setTrusted('shared-tool', false)
    expect(skillIndexText(reg)).toBe(untrusted)
  })

  it('hands out fresh arrays from all() and enabled()', () => {
    const first = reg.enabled()
    first.pop()
    reg.all().length = 0
    expect(reg.enabled().map((s) => s.manifest.name)).toEqual(['clean-downloads', 'weekly-report'])
    expect(reg.all()).toHaveLength(2)
  })
})
