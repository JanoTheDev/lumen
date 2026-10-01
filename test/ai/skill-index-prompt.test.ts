import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SKILLS_NOTE, SYSTEM_PREFIX, systemBlocks } from '../../src/main/ai/prompts/assemble'
import { ROUTER_PROMPT, routerSystem } from '../../src/main/ai/prompts/router'
import { normalizeRoute, routeSchema } from '../../src/main/query/router'
import { skillIndexText } from '../../src/main/skills/disclosure'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { skillMd, tempRoots, writeSkill, type TempRoots } from '../skills/fixtures'

let r: TempRoots
afterEach(() => r?.cleanup())

function registry(): SkillRegistry {
  r = tempRoots()
  const state = new SkillStateStore(join(r.base, 'state.json'))
  writeSkill(r.user, 'clean-downloads', { description: 'Sorts the Downloads folder.' })
  writeSkill(r.user, 'weekly-report', { description: 'Builds the weekly report.' })
  return new SkillRegistry(r, { state }).load()
}

describe('skills index in the system prompt', () => {
  it('is a second cacheable block after the fixed prefix, only when skills exist', () => {
    expect(systemBlocks()).toEqual([{ text: SYSTEM_PREFIX, cacheable: true }])
    const index = skillIndexText(registry())
    const blocks = systemBlocks(index)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ text: SYSTEM_PREFIX, cacheable: true })
    expect(blocks[1].cacheable).toBe(true)
    expect(blocks[1].text).toContain('- clean-downloads: Sorts the Downloads folder.')
    expect(blocks[1].text).toContain(SKILLS_NOTE)
  })

  it('does not change when a skill body is edited', () => {
    const reg = registry()
    const before = systemBlocks(skillIndexText(reg))
    writeFileSync(
      join(r.user, 'clean-downloads', 'SKILL.md'),
      skillMd('clean-downloads', {
        description: 'Sorts the Downloads folder.',
        body: 'Completely different steps.'
      })
    )
    reg.load()
    expect(systemBlocks(skillIndexText(reg))).toEqual(before)
  })

  it('the router gets the same index and may name a skill', () => {
    const index = skillIndexText(registry())
    expect(routerSystem()).toEqual([{ text: ROUTER_PROMPT, cacheable: true }])
    expect(routerSystem(index)[1]).toEqual({ text: index, cacheable: true })
    const raw = routeSchema.parse({
      mode: 'plan',
      needsScreen: false,
      needsUia: false,
      appSwitch: false,
      confidence: 0.9,
      skill: { name: ' clean-downloads ', args: [{ name: 'days', value: '7' }] }
    })
    expect(normalizeRoute(raw).skill).toEqual({
      name: 'clean-downloads',
      args: [{ name: 'days', value: '7' }]
    })
    expect(normalizeRoute({ ...raw, skill: { name: ' ' } }).skill).toBeUndefined()
  })
})
