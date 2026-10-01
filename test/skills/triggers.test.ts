import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { matchSkillTrigger, normalizeUtterance, similarity } from '../../src/main/skills/triggers'
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

describe('normalizeUtterance', () => {
  it('drops case, punctuation and fillers at both ends', () => {
    expect(normalizeUtterance('Hey Lumen, please clean my Downloads!')).toBe('clean my downloads')
    expect(normalizeUtterance("What's on today, please?")).toBe('whats on today')
  })
})

describe('similarity', () => {
  it('is 1 for equal text and low for different lengths', () => {
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('a', 'abcdef')).toBe(0)
    expect(similarity('clean my downloads', 'clean my download')).toBeGreaterThan(0.9)
  })
})

describe('matchSkillTrigger', () => {
  beforeEach(() => {
    writeSkill(r.user, 'morning-briefing', { extra: 'triggers: ["morning", "good morning"]' })
    writeSkill(r.user, 'clean-downloads', { extra: 'triggers: ["clean my downloads"]' })
    writeSkill(r.user, 'export-for-youtube', {
      extra: 'apps: [davinci-resolve]\ntriggers: ["export for youtube"]'
    })
    writeSkill(r.user, 'export-for-vimeo', { extra: 'triggers: ["export for vimeo"]' })
    reg.load()
  })

  it('routes the "morning" trigger exactly', () => {
    expect(matchSkillTrigger('Good morning!', reg)).toMatchObject({
      kind: 'skill',
      name: 'morning-briefing',
      exact: true
    })
    expect(matchSkillTrigger('morning', reg)).toMatchObject({ name: 'morning-briefing' })
  })

  it('matches small speech-recognition slips fuzzily', () => {
    expect(matchSkillTrigger('clean my download', reg)).toMatchObject({
      kind: 'skill',
      name: 'clean-downloads',
      exact: false
    })
  })

  it('matches "run the <name> skill"', () => {
    expect(matchSkillTrigger('run the clean downloads skill', reg)).toMatchObject({
      name: 'clean-downloads'
    })
    expect(matchSkillTrigger('use morning briefing', reg)).toMatchObject({
      name: 'morning-briefing'
    })
  })

  it('ignores unrelated sentences and disabled skills', () => {
    expect(matchSkillTrigger('what is the weather like', reg)).toBeNull()
    expect(matchSkillTrigger('morning is when I like coffee the most', reg)).toBeNull()
    state.setEnabled('morning-briefing', false)
    expect(matchSkillTrigger('good morning', reg)).toBeNull()
  })

  it('prefers the skill for the app in front, and the general one elsewhere', () => {
    writeSkill(r.user, 'export-for-youtube-short', {
      extra: 'triggers: ["export for youtube"]'
    })
    reg.load()
    const tie = matchSkillTrigger('export for youtube', reg)
    expect(tie).toMatchObject({ kind: 'skill', name: 'export-for-youtube-short' })
    expect(matchSkillTrigger('export for youtube', reg, { app: 'davinci-resolve' })).toMatchObject({
      kind: 'skill',
      name: 'export-for-youtube'
    })
  })

  it('says "Did you mean X or Y?" for a real tie', () => {
    writeSkill(r.user, 'tidy-desktop', { extra: 'triggers: ["tidy up"]' })
    writeSkill(r.user, 'tidy-inbox', { extra: 'triggers: ["tidy up"]' })
    reg.load()
    expect(matchSkillTrigger('tidy up', reg)).toEqual({
      kind: 'ambiguous',
      names: ['tidy-desktop', 'tidy-inbox'],
      question: 'Did you mean tidy desktop or tidy inbox?'
    })
  })

  it('is fast enough for the local grammar (< 150 ms with 200 skills)', () => {
    for (let i = 0; i < 200; i++)
      writeSkill(r.user, `skill-${i}`, {
        extra: `triggers: ["do thing number ${i}", "another phrase ${i}"]`
      })
    reg.load()
    const t0 = performance.now()
    matchSkillTrigger('do thing number 150', reg)
    expect(performance.now() - t0).toBeLessThan(150)
  }, 30_000)

  it('works on the builtin skills', () => {
    const builtin = new SkillRegistry({
      builtin: resolve(__dirname, '../../skills/builtin'),
      appPacks: join(r.base, 'none'),
      user: join(r.base, 'none-user')
    }).load()
    expect(matchSkillTrigger('good morning', builtin)).toMatchObject({ name: 'morning-briefing' })
    expect(matchSkillTrigger('summarize this page', builtin)).toMatchObject({
      name: 'summarize-this-page'
    })
  })
})
