import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodingSkillDraft } from '@shared/coding-skills'
import { matchCodingSkillIntent, splitNames } from '../../src/main/coding-skills/intents'
import { CodingSkillLibrary } from '../../src/main/coding-skills/library'
import { CodingSkills } from '../../src/main/coding-skills/service'
import { CodingSkillVoice, findSkill } from '../../src/main/coding-skills/voice'
import { skillFromAuthor } from '../../src/main/coding-skills/authored'
import { parseSkillMd } from '../../src/main/coding-skills/skillmd'
import type { Complete } from '../../src/main/web/summarize'

describe('coding-skill intents', () => {
  it('reads the commands from the request', () => {
    expect(
      matchCodingSkillIntent('Add a skill for better-auth from https://www.better-auth.com/docs.')
    ).toEqual({
      kind: 'add-docs',
      topic: 'better-auth',
      url: 'https://www.better-auth.com/docs',
      explicit: true
    })
    expect(matchCodingSkillIntent('add a skill for Next.js')).toMatchObject({
      kind: 'add-docs',
      topic: 'Next.js',
      explicit: false
    })
    expect(
      matchCodingSkillIntent('use the Next.js and better-auth skills for this project')
    ).toEqual({ kind: 'use', names: ['Next.js', 'better-auth'], project: 'this project' })
    expect(matchCodingSkillIntent('what skills is Claude using here?')).toEqual({ kind: 'list' })
    expect(matchCodingSkillIntent('what skills is claude using in lumen')).toEqual({
      kind: 'list',
      project: 'lumen'
    })
    expect(matchCodingSkillIntent('drop the prisma skill')).toEqual({
      kind: 'drop',
      name: 'prisma',
      explicit: true
    })
    expect(matchCodingSkillIntent('update the better-auth skill')).toEqual({
      kind: 'update',
      name: 'better-auth',
      explicit: false
    })
    expect(
      matchCodingSkillIntent('import the pdf skill from https://github.com/o/r/tree/main/skills')
    ).toEqual({ kind: 'import', from: 'https://github.com/o/r/tree/main/skills', pick: 'pdf' })
    expect(
      matchCodingSkillIntent('write a coding skill for API rules: validate input with zod')
    ).toEqual({ kind: 'write', title: 'API rules', text: 'validate input with zod' })
    expect(matchCodingSkillIntent('suggest skills for this project')).toEqual({ kind: 'suggest' })
    expect(matchCodingSkillIntent('save it')).toEqual({ kind: 'draft', cmd: 'save' })
    // Lumen's own skill phrases and unrelated talk are left alone.
    expect(matchCodingSkillIntent('make a skill that opens my mail')).toBeNull()
    expect(matchCodingSkillIntent('what changed')).toBeNull()
    expect(splitNames('next.js, prisma and the drizzle')).toEqual(['next.js', 'prisma', 'drizzle'])
  })
})

describe('coding-skill voice', () => {
  let dir: string
  let project: string
  let lib: CodingSkillLibrary
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-cs-'))
    project = join(dir, 'shop')
    mkdirSync(project)
    writeFileSync(join(project, 'package.json'), '{"dependencies":{"next":"15","prisma":"6"}}')
    lib = new CodingSkillLibrary(join(dir, 'lib'))
    for (const [name, title] of [
      ['nextjs', 'Next.js'],
      ['prisma', 'Prisma']
    ])
      lib.save({
        info: {
          name,
          title,
          description: 'd',
          source: { kind: 'docs', urls: ['https://x.dev/docs'] },
          packages: [name === 'nextjs' ? 'next' : 'prisma']
        },
        skillMd: `---\nname: ${name}\ndescription: "${title}"\n---\n\nNotes.\n`
      })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  interface Harness {
    v: CodingSkillVoice
    changed: ReturnType<typeof vi.fn>
    notices: string[]
    shown: CodingSkillDraft[]
    skills: CodingSkills
  }

  function voice(focused = true): Harness {
    const changed = vi.fn()
    const notices: string[] = []
    const shown: CodingSkillDraft[] = []
    const skills = new CodingSkills({
      library: lib,
      distill: {
        complete: vi.fn(async () => null) as unknown as Complete,
        // No network in tests: every page is missing.
        get: async (url) => ({ url, status: 404, contentType: 'text/html', body: 'x', cut: false })
      },
      now: () => 1000,
      newId: () => 'd1',
      changed
    })
    const v = new CodingSkillVoice({
      skills,
      focusedProject: () => (focused ? { path: project, name: 'shop' } : null),
      matchProject: (s) => (s === 'shop' ? { path: project, name: 'shop' } : null),
      reloadNote: () => 'Claude picks it up from its next turn.',
      notify: (t) => notices.push(t),
      showDraft: (d) => shown.push(d),
      now: () => 1000,
      log: () => {}
    })
    return { v, changed, notices, shown, skills }
  }

  it('attaches, lists and drops skills for the focused project', () => {
    const { v, changed } = voice()
    expect(v.intercept('what skills is Claude using here')?.text).toMatch(/no coding skills/)
    const r = v.intercept('use the Next.js and Prisma skills for this project')
    expect(r?.text).toBe(
      'Claude will use the Next.js and Prisma skills in shop. Claude picks it up from its next turn.'
    )
    expect(lib.attached(project)).toEqual(['nextjs', 'prisma'])
    expect(changed).toHaveBeenCalledWith([project])
    expect(v.intercept('what skills is Claude using here')?.text).toBe(
      'Claude uses 2 skills in shop: Next.js and Prisma.'
    )
    expect(v.intercept('drop the prisma skill')?.text).toMatch(
      /^Dropped the Prisma skill from shop/
    )
    expect(lib.attached(project)).toEqual(['nextjs'])
    expect(v.intercept('drop the prisma skill')?.text).toBe('shop doesn’t use the Prisma skill.')
    expect(existsSync(join(project, '.claude'))).toBe(false)
    expect(v.intercept('save the Next.js skill to the project')?.text).toMatch(
      /^Saved the Next.js skill into shop/
    )
    expect(existsSync(join(project, '.claude', 'skills', 'nextjs', 'SKILL.md'))).toBe(true)
  })

  it('names the project when none is focused, and lets unknown phrases through', () => {
    const { v } = voice(false)
    expect(v.intercept('what skills is Claude using here')?.text).toMatch(/^Which project/)
    expect(v.intercept('use the prisma skill for shop')?.text).toMatch(/Prisma skill in shop/)
    // Not a coding skill and not a known library: Lumen's own skills handle it.
    expect(v.intercept('use the morning mail skill with gmail')).toBeUndefined()
    expect(v.intercept('update the morning mail skill')).toBeUndefined()
    expect(v.intercept('add a skill for my weird thing')).toBeUndefined()
    // No draft waiting: "save it" is not ours.
    expect(v.intercept('save it')).toBeUndefined()
  })

  it('finds skills by title, name or catalog alias', () => {
    const list = lib.list()
    expect(findSkill('next js', list)?.name).toBe('nextjs')
    expect(findSkill('Next.js', list)?.name).toBe('nextjs')
    expect(findSkill('PRISMA', list)?.name).toBe('prisma')
    expect(findSkill('drizzle', list)).toBeNull()
  })

  it('suggests what the project uses', () => {
    const { v } = voice()
    expect(v.intercept('suggest skills')?.text).toMatch(/You have skills for Next.js and Prisma/)
  })

  it('reports a failed docs read as a notice after the reply', async () => {
    const { v, notices, shown } = voice()
    const r = v.intercept('add a skill for drizzle')
    expect(r?.text).toMatch(/Reading the Drizzle ORM docs/)
    await new Promise((res) => setTimeout(res, 50))
    expect(shown).toEqual([])
    expect(notices[0]).toMatch(/^I couldn’t make the skill: the docs page answered HTTP 404/)
  })
})

describe('write your own via Lumen’s authorSkill', () => {
  it('re-renders the authored draft as a Claude-format coding skill', async () => {
    const author = vi.fn(async (req: { description: string; kind?: string; context?: string }) => {
      expect(req.kind).toBe('coding')
      expect(req.context).toMatch(/Claude Code/)
      return {
        ok: true as const,
        draft: {
          name: 'api-rules',
          description: 'How this project writes API routes.',
          whenToUse: 'when adding or changing an API route',
          triggers: ['api rules'],
          params: [],
          instructions: '1. Put routes in src/api.\n2. Validate input with zod.',
          permissions: { input: false, network: [] },
          source: 'model' as const,
          references: [{ path: 'reference/errors.md', text: 'Use problem+json.' }]
        },
        files: { skillMd: '' },
        warnings: []
      }
    })
    const s = await skillFromAuthor(author, 'API rules', 'routes in src/api, zod')
    const p = parseSkillMd(s.skillMd)
    expect(p.name).toBe('api-rules')
    expect(p.whenToUse).toBe('when adding or changing an API route')
    expect(s.skillMd).not.toMatch(/triggers|permissions/)
    expect(p.body).toContain('Validate input with zod')
    expect(s.files).toEqual([{ path: 'reference/errors.md', text: 'Use problem+json.' }])
    await expect(
      skillFromAuthor(async () => ({ ok: false as const, error: 'no key' }), 'x', 'y')
    ).rejects.toThrow('no key')
  })
})
