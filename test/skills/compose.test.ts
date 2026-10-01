import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/ai/providers', () => ({ getProvider: vi.fn() }))

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  authorSkill,
  composeTurn,
  draftFromCompose,
  matchComposeIntent,
  permissionWords,
  websitePattern,
  type ComposeOutput
} from '../../src/main/skills/compose'
import { parseSkillFile } from '../../src/main/skills/manifest'
import { validateSkillDir } from '../../src/main/skills/kind'
import { writeNewSkill } from '../../src/main/skills/manage'
import { SkillRegistry } from '../../src/main/skills/registry'
import { SkillStateStore } from '../../src/main/skills/state'
import { tempRoots } from './fixtures'

function output(over: Partial<ComposeOutput> = {}): ComposeOutput {
  return {
    name: 'Morning Mail',
    description: 'Opens the mail and reads the first unread messages.',
    when_to_use: 'when the user asks for their morning mail',
    triggers: ['Morning mail!', 'read my mail'],
    instructions:
      '1. Open the mail app (launch_app "Mail").\n2. observe; find the "Inbox" list.\n3. Read the senders and subjects of {count} unread messages.\n4. Done when you have read them.',
    params: [{ name: 'count', description: 'how many messages' }],
    apps: ['outlook', 'not-a-known-app'],
    needs_input: true,
    websites: [
      'https://mail.google.com/mail/u/0',
      'http://insecure.example.com',
      'javascript:alert(1)'
    ],
    profile: false,
    connectors: ['github', 'gmail'],
    tools: ['observe', 'act', 'launch_app', 'nuke_disk'],
    steps_json: '',
    references: [{ file: 'Tone Guide.md', content: 'Be brief.' }],
    ...over
  }
}

describe('model-written skills (compose)', () => {
  it('turns the model output into a valid, least-privilege SKILL.md', async () => {
    const r = await authorSkill(
      { description: 'read my morning mail', apps: ['outlook'], connectors: ['gmail'] },
      { words: async () => output() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { manifest, body } = parseSkillFile(r.files.skillMd)
    expect(manifest).toMatchObject({
      name: 'morning-mail',
      when_to_use: 'when the user asks for their morning mail',
      triggers: ['morning mail', 'read my mail'],
      apps: ['outlook'],
      tools: ['observe', 'act', 'launch_app', 'finish']
    })
    expect(manifest.permissions).toMatchObject({
      input: true,
      network: ['https://mail.google.com'],
      connectors: ['gmail'],
      profile: false,
      risky: false
    })
    expect(Object.keys(manifest.params)).toEqual(['count'])
    expect(body).toMatch(/\{count\}/)
    expect(r.files.extra).toEqual([{ path: 'reference/tone-guide.md', text: 'Be brief.\n' }])
    expect(r.warnings.join(' ')).toMatch(/insecure\.example\.com/)
  })

  it('keeps no input tools, websites or steps for a read-only skill', () => {
    const { draft, warnings } = draftFromCompose(
      output({
        needs_input: false,
        steps_json: '{"version":1,"steps":[{"do":"keys","combo":"ctrl+s"}]}'
      }),
      { description: 'x' }
    )
    expect(draft.permissions).toEqual({ input: false, network: [] })
    expect(draft.tools).toEqual(['observe', 'finish'])
    expect(draft.steps).toBeUndefined()
    expect(warnings.join(' ')).toMatch(/fixed steps/)
  })

  it('keeps valid fixed steps and drops broken ones', () => {
    const ok = draftFromCompose(
      output({ steps_json: '{"version":1,"steps":[{"do":"keys","combo":"ctrl+n"}]}' }),
      { description: 'x' }
    )
    expect(ok.draft.steps?.steps).toEqual([{ do: 'keys', combo: 'ctrl+n' }])
    const bad = draftFromCompose(output({ steps_json: '{"steps":[{"do":"click"}]}' }), {
      description: 'x'
    })
    expect(bad.draft.steps).toBeUndefined()
    expect(bad.warnings.join(' ')).toMatch(/AI guides every run/)
  })

  it('clamps a style skill to words only', () => {
    const { draft } = draftFromCompose(output(), { description: 'brief replies', kind: 'style' })
    expect(draft.permissions).toEqual({ input: false, network: [] })
    expect(draft.tools).toBeUndefined()
    expect(composeTurn({ description: 'brief', kind: 'style' })).toMatch(/reply-style skill/)
  })

  it('picks a free name and refuses empty output', async () => {
    const r = await authorSkill(
      { description: 'read my morning mail' },
      { words: async () => output(), taken: (n) => n === 'morning-mail' }
    )
    expect(r.ok && r.draft.name).toBe('morning-mail-2')
    const none = await authorSkill({ description: 'read my mail' }, { words: async () => null })
    expect(none).toEqual({ ok: false, error: 'the AI did not return a skill' })
    const short = await authorSkill({ description: 'x' }, { words: async () => output() })
    expect(short.ok).toBe(false)
  })

  it('writes files that pass the installer checks', async () => {
    const r = await authorSkill({ description: 'mail' }, { words: async () => output() })
    if (!r.ok) throw new Error(r.error)
    const roots = tempRoots()
    try {
      const reg = new SkillRegistry(roots, {
        state: new SkillStateStore(join(roots.base, 's.json'))
      }).load()
      expect(writeNewSkill(reg, r.draft.name, r.files)).toMatchObject({ ok: true })
      const dir = join(roots.user, 'morning-mail')
      expect(validateSkillDir(dir)).toEqual([])
      expect(readFileSync(join(dir, 'reference', 'tone-guide.md'), 'utf8')).toBe('Be brief.\n')
      expect(reg.get('morning-mail')?.origin).toBe('user')
      expect(reg.trustOf(reg.get('morning-mail')!)).toBe('mine')
    } finally {
      roots.cleanup()
    }
  })

  it('refuses reference files outside reference/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumen-x-'))
    try {
      const roots = tempRoots()
      const reg = new SkillRegistry(roots, {
        state: new SkillStateStore(join(roots.base, 's.json'))
      }).load()
      const r = writeNewSkill(reg, 'evil', {
        skillMd: '---\nname: evil\ndescription: x\n---\nbody\n',
        extra: [{ path: '../evil.md', text: 'x' }]
      })
      expect(r.ok).toBe(false)
      expect(existsSync(join(roots.user, 'evil'))).toBe(false)
      roots.cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches "make a skill that …" but not "when I say"', () => {
    expect(matchComposeIntent('Make a skill that opens my mail every morning')).toEqual({
      description: 'opens my mail every morning'
    })
    expect(matchComposeIntent('create a skill for tidying the desktop.')).toEqual({
      description: 'tidying the desktop'
    })
    expect(matchComposeIntent('can you make me a new skill to export PNGs')).toEqual({
      description: 'export PNGs'
    })
    expect(matchComposeIntent('create a skill: whenever I say hi, wave')).toBeNull()
    expect(matchComposeIntent('make a sandwich')).toBeNull()
  })

  it('speaks permissions plainly and accepts only https origins', () => {
    expect(permissionWords({ input: true, network: ['https://mail.google.com'] })).toBe(
      'It may use your mouse and keyboard and open mail.google.com.'
    )
    expect(permissionWords({ input: false, network: [] })).toMatch(/only reads/)
    expect(websitePattern('mail.google.com')).toBe('https://mail.google.com')
    expect(websitePattern('https://*.example.com')).toBe('https://*.example.com')
    expect(websitePattern('http://x.com')).toBeNull()
    expect(websitePattern('https://user:pw@x.com')).toBeNull()
  })

  it('refuses wildcards over a whole top-level or shared domain and says what they cover', () => {
    expect(websitePattern('https://*.com')).toBeNull()
    expect(websitePattern('https://*.co.uk')).toBeNull()
    expect(websitePattern('https://*.github.io')).toBeNull()
    expect(websitePattern('https://*.x*.com')).toBeNull()
    expect(websitePattern('https://*.google.com')).toBe('https://*.google.com')
    expect(websitePattern('https://*.bbc.co.uk')).toBe('https://*.bbc.co.uk')
    expect(permissionWords({ input: true, network: ['https://*.google.com'] })).toBe(
      'It may use your mouse and keyboard and open any page on google.com.'
    )
  })
})
