import { describe, expect, it } from 'vitest'
import type { SkillPermissions, SkillSummary } from '@shared/types'
import {
  asksForMore,
  filterSkills,
  permissionLines,
  skillMeta
} from '../../src/renderer/src/panel/settings/sections/SkillsText'

const none: SkillPermissions = {
  input: false,
  network: [],
  files: { read: [], write: [] },
  connectors: [],
  profile: false,
  risky: false,
  screen: false
}

const skill = (over: Partial<SkillSummary>): SkillSummary => ({
  name: 'clean-downloads',
  description: 'Sorts the Downloads folder.',
  version: '1.0.0',
  apps: [],
  triggers: ['tidy my downloads'],
  permissions: none,
  context: 'foreground',
  trust: 'builtin',
  origin: 'builtin',
  enabled: true,
  hasSteps: false,
  warnings: [],
  ...over
})

describe('Settings → Skills text', () => {
  it('says what a skill may do in plain words', () => {
    expect(permissionLines(none)).toEqual(['Only reads the screen and answers'])
    expect(asksForMore(none)).toBe(false)
    const p = { ...none, input: true, files: { read: ['~/Downloads'], write: [] }, risky: true }
    expect(permissionLines(p, ['gimp'])).toEqual([
      'Uses your mouse and keyboard in gimp',
      'Reads files in ~/Downloads',
      'Asks before every action'
    ])
    expect(asksForMore(p)).toBe(true)
  })

  it('filters by name, description, trigger and trust words', () => {
    const list = [
      skill({}),
      skill({ name: 'reply', description: 'Replies.', triggers: [], trust: 'community-untrusted' })
    ]
    expect(filterSkills(list, 'tidy').map((s) => s.name)).toEqual(['clean-downloads'])
    expect(filterSkills(list, 'untrusted').map((s) => s.name)).toEqual(['reply'])
    expect(filterSkills(list, '')).toHaveLength(2)
  })

  it('builds the status line', () => {
    expect(skillMeta(skill({ enabled: false, overrides: 'builtin', trust: 'mine' }))).toBe(
      'yours · v1.0.0 · replaces the built-in one · say “tidy my downloads” · off'
    )
  })
})
