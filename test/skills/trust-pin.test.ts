import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MARKER_FILE } from '../../src/main/packs/install'
import { zip } from '../../src/main/packs/zip-write'
import { installArchive, previewArchive } from '../../src/main/skills/manage'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore, trustPin } from '../../src/main/skills/state'
import { skillMd, tempRoots, writeSkill, type TempRoots } from './fixtures'

let r: TempRoots
let state: SkillStateStore
let reg: SkillRegistry
const stateFile = (): string => join(r.base, 'skills-state.json')

beforeEach(() => {
  r = tempRoots()
  state = new SkillStateStore(stateFile())
  reg = new SkillRegistry(r, { state }).load()
})
afterEach(() => r.cleanup())

const pack = (name: string, body: string): Buffer =>
  zip([{ name: `${name}/SKILL.md`, data: Buffer.from(skillMd(name, { body })) }])

function trust(name: string): void {
  const s = reg.get(name)!
  state.setTrusted(name, true, s.pin)
}

describe('skill trust is pinned to the pack', () => {
  it('a skill of the same name from another pack starts untrusted, and the preview says so', () => {
    expect(
      installArchive(reg, pack('email-digest', 'From author A.'), 'https://a.test/a.lumen')
    ).toMatchObject({ ok: true })
    trust('email-digest')
    expect(reg.trustOf(reg.get('email-digest')!)).toBe('community-trusted')

    const evil = pack('email-digest', 'From author B.')
    const preview = previewArchive(reg, evil, undefined, 'https://b.test/b.lumen')
    expect(preview).toMatchObject({
      ok: true,
      skills: [{ name: 'email-digest', updates: true, resetsTrust: true }]
    })
    expect(installArchive(reg, evil, 'https://b.test/b.lumen')).toMatchObject({
      ok: true,
      installed: [{ id: 'email-digest', updated: true }]
    })
    expect(reg.trustOf(reg.get('email-digest')!)).toBe('community-untrusted')
    // The saved trust is gone, so reinstalling A later does not bring it back silently.
    expect(state.isTrusted('email-digest')).toBe(false)
    expect(new SkillStateStore(stateFile()).get().trusted).toEqual([])
  })

  it('the same archive from the same source keeps its trust', () => {
    const a = pack('tidy', 'Same.')
    installArchive(reg, a, 'tidy.lumen')
    trust('tidy')
    expect(previewArchive(reg, a, undefined, 'tidy.lumen')).toMatchObject({
      skills: [{ updates: true }]
    })
    expect(
      (previewArchive(reg, a, undefined, 'tidy.lumen') as { skills: { resetsTrust?: boolean }[] })
        .skills[0].resetsTrust
    ).toBeUndefined()
    installArchive(reg, a, 'tidy.lumen')
    expect(reg.trustOf(reg.get('tidy')!)).toBe('community-trusted')
    // Same bytes from somewhere else: another pin.
    installArchive(reg, a, 'https://elsewhere.test/tidy.lumen')
    expect(reg.trustOf(reg.get('tidy')!)).toBe('community-untrusted')
  })

  it('trust saved before pins is bound to the pack installed at the next load', () => {
    const dir = writeSkill(r.user, 'old-one')
    const marker = { format: 1, kind: 'agent-skill', id: 'old-one', source: 'a.lumen' }
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ ...marker, sha256: 'aa' }))
    writeFileSync(stateFile(), JSON.stringify({ disabled: [], trusted: ['old-one'] }))
    state = new SkillStateStore(stateFile())
    reg = new SkillRegistry(r, { state }).load()
    expect(reg.trustOf(reg.get('old-one')!)).toBe('community-trusted')
    expect(new SkillStateStore(stateFile()).get().pins).toEqual({
      'old-one': trustPin({ source: 'a.lumen', sha256: 'aa' })
    })
    // Another pack's content under the same name is not trusted.
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ ...marker, sha256: 'bb' }))
    reg.load()
    expect(reg.trustOf(reg.get('old-one')!)).toBe('community-untrusted')
  })

  it('untrusting or deleting drops the pin', () => {
    installArchive(reg, pack('x', 'X.'), 'x.lumen')
    trust('x')
    state.setTrusted('x', false)
    expect(state.get().pins).toEqual({})
    trust('x')
    state.forget('x')
    expect(state.get()).toMatchObject({ trusted: [], pins: {} })
  })
})
