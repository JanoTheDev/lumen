// The starter skills in skills/builtin (11 T08): every one loads cleanly, and the L1 prompt
// text they produce is pinned (prompt-size snapshot).
import { readdirSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { skillIndexText, loadSkill } from '../../src/main/skills/disclosure'
import { estimateTokens } from '../../src/main/skills/manifest'
import { SkillRegistry } from '../../src/main/skills/registry'

const APP = resolve(__dirname, '../../skills')
const BUILTIN = join(APP, 'builtin')
const reg = new SkillRegistry({ builtin: BUILTIN, appPacks: APP, user: join(BUILTIN, '.none') })
reg.load()

const STARTERS = [
  'clean-downloads',
  'export-for-youtube',
  'fill-this-form-from-profile',
  'focus-mode-on',
  'make-text-bigger-here',
  'morning-briefing',
  'read-this-aloud',
  'reply-to-this-email',
  'screenshot-and-explain',
  'search-my-mail',
  'summarize-my-inbox',
  'summarize-this-page',
  'write-an-email'
]
/** Reply styles (`kind: style`): listed by styles(), never in the index or triggers. */
const STYLES = ['brief', 'explain-like-im-new', 'formal', 'friendly', 'teacher']
const ALL = [...STARTERS, ...STYLES].sort()

describe('builtin skills', () => {
  it('all load without problems or warnings', () => {
    expect(reg.problems()).toEqual([])
    expect(
      readdirSync(BUILTIN)
        .filter((n) => !n.includes('.'))
        .sort()
    ).toEqual(ALL)
    expect(reg.all().map((s) => s.manifest.name)).toEqual(ALL)
    expect(reg.enabled().map((s) => s.manifest.name)).toEqual(STARTERS)
    expect(reg.styles().map((s) => s.manifest.name)).toEqual(STYLES)
    for (const s of reg.all()) {
      expect(s.warnings, s.manifest.name).toEqual([])
      expect(reg.trustOf(s)).toBe('builtin')
    }
  })

  it('every body loads, with its params filled and its reference files listed', () => {
    for (const name of STARTERS) {
      const out = loadSkill(reg, { name })
      expect(out.isError, name).toBeUndefined()
      expect(out.content[0].text, name).not.toMatch(
        /\{(tone|resolution|steps|message|to|about|forward|count|query|open)\}/
      )
    }
    expect(loadSkill(reg, { name: 'export-for-youtube' }).content[0].text).toContain(
      'reference/resolve.md'
    )
  })

  it('only claim the permissions they need', () => {
    const p = (n: string): ReturnType<typeof reg.get> => reg.get(n)
    for (const n of [
      'summarize-this-page',
      'read-this-aloud',
      'screenshot-and-explain',
      'focus-mode-on'
    ])
      expect(p(n)!.manifest.permissions.input, n).toBe(false)
    expect(p('clean-downloads')!.manifest.permissions).toMatchObject({
      input: false,
      risky: true,
      files: { read: ['~/Downloads'], write: ['~/Downloads'] }
    })
    expect(p('fill-this-form-from-profile')!.manifest.permissions).toMatchObject({
      profile: true,
      risky: true
    })
  })

  it('L1 prompt text (snapshot) fits the budget', () => {
    const text = skillIndexText(reg)
    expect(estimateTokens(text)).toBeLessThan(1500)
    expect(text).toMatchSnapshot()
  })
})
