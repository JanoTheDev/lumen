import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { join } from 'path'
import { readFileSync } from 'fs'
import { callModel } from '../../src/main/ai'
import { setProvider } from '../../src/main/ai/providers'
import type { ChatChunk, LlmProvider, StructuredRequest } from '../../src/main/ai/providers/types'
import { estimateTokens } from '../../src/main/ai/prompts/assemble'
import {
  matchSkill,
  setSkillsDir,
  shortcutsExcerpt,
  SKILL_TOKEN_CAP,
  skillContext,
  skillPacks
} from '../../src/main/ai/skills'
import { resolveTarget, type GroundingContext } from '../../src/main/query/resolve-target'
import { setScreenAdapter } from '../../src/main/actions/coords'

const SKILLS = join(__dirname, '../../skills')

beforeEach(() => setSkillsDir(SKILLS))

describe('skill matching', () => {
  it('matches on process, then url glob, then title regex', () => {
    expect(matchSkill({ process: 'C:\\Program Files\\Blender\\blender.exe' })?.id).toBe('blender')
    expect(matchSkill({ process: 'excel.exe', title: 'x' })?.id).toBe('excel')
    expect(matchSkill({ title: 'Book1 - Excel' })?.id).toBe('excel')
    expect(matchSkill({ url: 'https://www.figma.com/design/abc/Thing' })?.id).toBe('figma')
    expect(matchSkill({ title: 'Settings' })?.id).toBe('windows')
    expect(matchSkill({ title: 'Settings - Google Chrome' })).toBeNull()
    expect(matchSkill({ process: 'notepad.exe', title: 'notes.txt - Notepad' })).toBeNull()
  })

  it('loads every shipped pack with its regions', () => {
    const packs = skillPacks()
    expect(packs.length).toBeGreaterThanOrEqual(10)
    expect(packs.find((p) => p.id === 'blender')?.regions['3d-viewport']).toMatchObject({
      x: 0,
      w: 0.79
    })
  })
})

describe('skill context', () => {
  it('stays within the 1.5k token cap for every shipped pack', () => {
    for (const p of skillPacks()) {
      const text = skillContext(p, 'how do I render and save the image')
      expect(estimateTokens(text), p.id).toBeLessThanOrEqual(SKILL_TOKEN_CAP)
      expect(text.length, p.id).toBeGreaterThan(500)
    }
  })

  it('enforces a smaller cap by dropping overview sections and shortcuts', () => {
    const blender = matchSkill({ process: 'blender.exe' })!
    const text = skillContext(blender, 'render', 400)
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
    expect(text.startsWith('# Blender')).toBe(true)
  })

  it('puts the shortcuts that match the request first', () => {
    const md = readFileSync(join(SKILLS, 'blender', 'shortcuts.md'), 'utf8')
    const excerpt = shortcutsExcerpt(md, 'render the animation', 60)
    expect(excerpt).toContain('Render animation: Ctrl+F12')
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(60)
    expect(shortcutsExcerpt(md, 'x', 0)).toBe('')
  })
})

describe('callModel with a skill pack', () => {
  const key = process.env.ANTHROPIC_API_KEY
  let seen: StructuredRequest<unknown> | null = null
  const reply = '{"mode":"answer","spoken":"Press F12."}'
  const provider: LlmProvider = {
    id: 'anthropic',
    async *stream(req): AsyncIterable<ChatChunk> {
      seen = req
      yield { type: 'text', text: reply }
      yield {
        type: 'done',
        result: {
          text: reply,
          model: 'claude-sonnet-5-5',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      }
    },
    complete: vi.fn(),
    warmup: async () => {}
  }
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    setProvider('anthropic', provider)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    setProvider('anthropic', null)
    process.env.ANTHROPIC_API_KEY = key
    vi.restoreAllMocks()
  })

  it('injects the Blender overview into the user turn, not the system prefix', async () => {
    await callModel('how do I render', null, 'untitled.blend - Blender 5.2')
    const turn = seen!.messages.at(-1)!.content
    expect(turn).toContain('<app_guide app="Blender">')
    expect(turn).toContain('## What this app is for')
    expect(turn).toContain('Render image: F12')
    expect(seen!.system.map((s) => s.text).join('')).not.toContain('app_guide')
  })

  it('adds nothing for an app without a pack', async () => {
    await callModel('hi', null, 'notes.txt - Notepad')
    expect(seen!.messages.at(-1)!.content).not.toContain('app_guide')
  })
})

describe('region targets', () => {
  afterEach(() => setScreenAdapter(null))

  it('resolve to the named area of the foreground window', async () => {
    const pack = matchSkill({ process: 'blender.exe' })!
    const ctx: GroundingContext = {
      frames: [
        {
          label: '1',
          geometry: {
            originX: 0,
            originY: 0,
            width: 1920,
            height: 1080,
            imgW: 1280,
            imgH: 720
          }
        }
      ],
      foreground: { rect: { x: 0, y: 0, w: 1920, h: 1080 } },
      skill: pack
    }
    const r = await resolveTarget({ kind: 'region', name: 'outliner' }, ctx)
    expect(r?.physRect).toEqual({ x: 1517, y: 30, w: 403, h: 324 })
    expect(r?.source).toBe('region')
    expect(r?.confidence).toBeLessThan(0.6)
    expect(await resolveTarget({ kind: 'region', name: 'nope' }, ctx)).toBeNull()
    expect(
      await resolveTarget({ kind: 'region', name: 'outliner' }, { ...ctx, skill: undefined })
    ).toBeNull()
  })
})
