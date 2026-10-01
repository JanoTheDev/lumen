// Voice commands for reply styles and making a style by voice.
import { describe, expect, it } from 'vitest'
import type { StyleInfo } from '@shared/styles'
import { applyStyleCommand, matchStyleCommand } from '../../src/main/ai/style-voice'
import { createStyleMaker, renderStyleMd, styleDraft } from '../../src/main/ai/style-make'
import { parseSkillFile } from '../../src/main/skills/manifest'

const style = (name: string, levels: string[] = [], extra: Partial<StyleInfo> = {}): StyleInfo => ({
  name,
  description: '',
  levels,
  trust: 'builtin',
  origin: 'builtin',
  enabled: true,
  warnings: [],
  ...extra
})
const STYLES = [
  style('caveman', ['lite', 'full', 'ultra']),
  style('explain-like-im-new'),
  style('formal')
]
const m = (t: string, active: { name: string; level?: string } | null = null): unknown =>
  matchStyleCommand(t, STYLES, active)

describe('matchStyleCommand', () => {
  it('turns a style on, with or without a level', () => {
    expect(m('turn on caveman mode')).toEqual({ cmd: 'on', name: 'caveman' })
    expect(m('Caveman mode on.')).toEqual({ cmd: 'on', name: 'caveman' })
    expect(m('switch to formal style please')).toEqual({ cmd: 'on', name: 'formal' })
    expect(m("explain like I'm new mode")).toEqual({ cmd: 'on', name: 'explain-like-im-new' })
    expect(m('caveman mode ultra')).toEqual({ cmd: 'on', name: 'caveman', level: 'ultra' })
    expect(m('turn on ultra caveman mode')).toEqual({ cmd: 'on', name: 'caveman', level: 'ultra' })
    expect(m('caveman mode level lite')).toEqual({ cmd: 'on', name: 'caveman', level: 'lite' })
    expect(m('set caveman level to full')).toEqual({ cmd: 'on', name: 'caveman', level: 'full' })
    expect(m('caveman mode mega')).toEqual({ cmd: 'on', name: 'caveman', badLevel: 'mega' })
  })

  it('turns styles off', () => {
    expect(m('caveman mode off')).toEqual({ cmd: 'off', name: 'caveman' })
    expect(m('turn off caveman mode')).toEqual({ cmd: 'off', name: 'caveman' })
    expect(m('normal mode')).toEqual({ cmd: 'off' })
    expect(m('talk normally again')).toEqual({ cmd: 'off' })
    expect(m('turn off the style')).toEqual({ cmd: 'off' })
  })

  it('asks which mode, changes the level of the active style', () => {
    expect(m('What mode am I in?')).toEqual({ cmd: 'which' })
    expect(m('which style is on')).toEqual({ cmd: 'which' })
    expect(m('ultra level', { name: 'caveman' })).toEqual({ cmd: 'level', level: 'ultra' })
    expect(m('set the level to lite', { name: 'caveman' })).toEqual({ cmd: 'level', level: 'lite' })
    expect(m('ultra level')).toBeNull()
  })

  it('leaves other modes and unknown names to their own handlers', () => {
    expect(m('focus mode on')).toBeNull()
    expect(m('turn off focus mode')).toBeNull()
    expect(m('turn on simple mode')).toBeNull()
    expect(m('pirate mode')).toBeNull()
    expect(m('what is the weather')).toBeNull()
  })

  it('starts making a style', () => {
    expect(m('make a style that talks like a pirate')).toEqual({ cmd: 'make', like: 'a pirate' })
    expect(m('create a mode that sounds like a sports commentator')).toEqual({
      cmd: 'make',
      like: 'a sports commentator'
    })
    expect(m('make a pirate mode')).toEqual({ cmd: 'make', like: 'pirate' })
  })
})

describe('applyStyleCommand', () => {
  it('sets, reports and clears the active style', () => {
    const on = applyStyleCommand({ cmd: 'on', name: 'caveman', level: 'ultra' }, STYLES, null)
    expect(on.set).toEqual({ name: 'caveman', level: 'ultra' })
    expect(on.text).toMatch(/Caveman mode is on, level ultra/)
    const which = applyStyleCommand({ cmd: 'which' }, STYLES, { name: 'caveman', level: 'lite' })
    expect(which.text).toMatch(/level lite/)
    expect(which.set).toBeUndefined()
    expect(applyStyleCommand({ cmd: 'off' }, STYLES, { name: 'formal' }).set).toBeNull()
    expect(applyStyleCommand({ cmd: 'off' }, STYLES, null).set).toBeUndefined()
    expect(
      applyStyleCommand({ cmd: 'off', name: 'caveman' }, STYLES, { name: 'formal' }).set
    ).toBeUndefined()
    expect(
      applyStyleCommand({ cmd: 'level', level: 'full' }, STYLES, { name: 'caveman' }).set
    ).toEqual({
      name: 'caveman',
      level: 'full'
    })
  })

  it('names the levels for a bad one; refuses a switched-off style; warns for untrusted', () => {
    const bad = applyStyleCommand({ cmd: 'on', name: 'caveman', badLevel: 'mega' }, STYLES, null)
    expect(bad.set).toBeUndefined()
    expect(bad.text).toMatch(/lite, full or ultra/)
    const off = [style('formal', [], { enabled: false })]
    expect(applyStyleCommand({ cmd: 'on', name: 'formal' }, off, null).set).toBeUndefined()
    const community = [style('pirate', [], { trust: 'community-untrusted' })]
    const r = applyStyleCommand({ cmd: 'on', name: 'pirate' }, community, null)
    expect(r.set).toEqual({ name: 'pirate' })
    expect(r.text).toMatch(/not trusted/)
  })
})

describe('style maker', () => {
  it('writes a valid kind: style SKILL.md from the words, cleaned', () => {
    const d = styleDraft(
      'a pirate',
      {
        name: 'Pirate Talk',
        description: 'Talks like a pirate.',
        instructions: '---\n# Heading\nSay arr. <script>\nKeep facts exact.'
      },
      (n) => n === 'pirate-talk',
      0
    )
    expect(d.name).toBe('pirate-talk-2')
    expect(d.instructions).not.toMatch(/---|# Heading|</)
    const parsed = parseSkillFile(renderStyleMd(d))
    expect(parsed.manifest.kind).toBe('style')
    expect(parsed.manifest.name).toBe('pirate-talk-2')
    expect(parsed.warnings).toEqual([])
  })

  it('falls back to plain words and runs the voice review', async () => {
    let now = 0
    const saved: string[] = []
    const maker = createStyleMaker({
      now: () => now,
      words: async () => {
        throw new Error('offline')
      },
      taken: () => false,
      save: (name, md) => {
        saved.push(name, md)
        return { ok: true }
      }
    })
    expect(maker.review('save it')).toBeNull()
    expect(await maker.make('a robot')).toMatch(/called a robot/)
    expect(maker.review('call it beep boop')).toMatch(/beep boop/)
    expect(maker.review('read it back')).toMatch(/a robot/)
    expect(maker.review('what time is it')).toBeNull()
    now = 3 * 60_000
    expect(maker.review('yes')).toBeNull()
    expect(maker.review('save it')).toMatch(/turn on beep boop mode/)
    expect(saved[0]).toBe('beep-boop')
    expect(saved[1]).toContain('kind: style')
    expect(maker.draft()).toBeNull()
  })
})
