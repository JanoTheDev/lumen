// skillOffersHelpers (08 T49 leftover): a foreground skill run offers run_subagents only when
// the skill confirms nothing, by the registry's trust (the user may have trusted a pack).
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ trust: null as null | string }))

vi.mock('../../src/main/skills', () => ({
  getSkillRegistry: () => (h.trust ? { trustOf: () => h.trust } : null)
}))

import { skillOffersHelpers } from '../../src/main/agent-mode/skill-tools'
import type { LoadedSkill } from '../../src/main/skills/registry'
import { permissionsSchema } from '../../src/main/skills/manifest'

function skill(risky: boolean, baseTrust: string): LoadedSkill {
  return {
    manifest: { name: 's', permissions: permissionsSchema.parse({ risky }) },
    baseTrust
  } as unknown as LoadedSkill
}

describe('skillOffersHelpers', () => {
  it('follows risky and the registry trust', () => {
    h.trust = null
    expect(skillOffersHelpers(skill(false, 'mine'))).toBe(true)
    expect(skillOffersHelpers(skill(false, 'builtin'))).toBe(true)
    expect(skillOffersHelpers(skill(true, 'mine'))).toBe(false)
    expect(skillOffersHelpers(skill(false, 'community-untrusted'))).toBe(false)
    // Trusted by the user after install: the registry's trust wins.
    h.trust = 'community-trusted'
    expect(skillOffersHelpers(skill(false, 'community-untrusted'))).toBe(true)
    h.trust = 'community-untrusted'
    expect(skillOffersHelpers(skill(false, 'community-trusted'))).toBe(false)
  })
})
