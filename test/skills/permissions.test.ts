import { describe, expect, it } from 'vitest'
import type { SkillManifest } from '@shared/types'
import { permissionsSchema } from '../../src/main/skills/manifest'
import {
  appAllowed,
  checkSkillCall,
  classifyToolCall,
  confirmsEveryAction,
  urlAllowed,
  type SkillVerdict
} from '../../src/main/skills/permissions'

const skill = (
  perms: Record<string, unknown> = {},
  extra: Partial<SkillManifest> = {}
): SkillManifest => ({
  name: 'export-for-youtube',
  description: 'x',
  version: '1.0.0',
  apps: [],
  triggers: [],
  params: {},
  permissions: permissionsSchema.parse(perms),
  context: 'foreground',
  ...extra
})

const check = (
  m: SkillManifest,
  tool: string,
  input: Record<string, unknown> = {},
  app = 'notepad'
): SkillVerdict => checkSkillCall(m, 'mine', classifyToolCall(tool, input, app))

describe('skill permissions', () => {
  it('blocks input for a skill without input, with a spoken reason', () => {
    const v = check(skill(), 'act', { op: 'click' })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toMatch(
        /^E_DENIED: the skill "export-for-youtube" is not allowed to use the mouse/
      )
      expect(v.spoken).toMatch(/export for youtube skill is not allowed/)
    }
    expect(check(skill(), 'keys', { combo: 'ctrl+s' }).ok).toBe(false)
    expect(check(skill(), 'launch_app', { app: 'Notepad' }).ok).toBe(false)
  })

  it('lets reading tools through', () => {
    for (const t of ['observe', 'wait_for', 'ask_user', 'finish', 'use_skill'])
      expect(check(skill(), t)).toEqual({ ok: true, confirm: false })
  })

  it('keeps input to the skill apps', () => {
    const m = skill({ input: true }, { apps: ['davinci-resolve'] })
    expect(check(m, 'act', {}, 'davinci-resolve').ok).toBe(true)
    expect(check(m, 'act', {}, 'Resolve.exe').ok).toBe(true)
    const other = check(m, 'act', {}, 'outlook')
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.reason).toMatch(/in outlook \(only in davinci-resolve\)/)
    expect(checkSkillCall(m, 'mine', { kind: 'input', tool: 'act', app: null }).ok).toBe(false)
    expect(check(m, 'launch_app', { app: 'DaVinci Resolve' }).ok).toBe(true)
    expect(check(m, 'launch_app', { app: 'Outlook' }).ok).toBe(false)
  })

  it('opens only the declared sites', () => {
    const m = skill({ input: true, network: ['https://*.youtube.com'] })
    expect(check(m, 'navigate', { url: 'https://www.youtube.com/upload' }).ok).toBe(true)
    expect(check(m, 'navigate', { url: 'https://youtube.com' }).ok).toBe(true)
    expect(check(m, 'navigate', { url: 'https://evil.com/?youtube.com' }).ok).toBe(false)
    expect(check(skill({ input: true }), 'navigate', { url: 'https://a.com' }).ok).toBe(false)
  })

  it('needs profile for memory search and keeps to the tools list', () => {
    expect(check(skill(), 'memory_search').ok).toBe(false)
    expect(check(skill({ profile: true }), 'memory_search').ok).toBe(true)
    const m = skill({ input: true }, { tools: ['observe', 'act', 'finish'] })
    expect(check(m, 'act').ok).toBe(true)
    expect(check(m, 'keys').ok).toBe(false)
  })

  it('confirms every action for risky and untrusted community skills', () => {
    const risky = skill({ input: true, risky: true })
    expect(check(risky, 'act')).toEqual({ ok: true, confirm: true })
    const plain = skill({ input: true })
    expect(
      checkSkillCall(plain, 'community-untrusted', { kind: 'input', tool: 'act', app: 'x' })
    ).toEqual({
      ok: true,
      confirm: true
    })
    expect(confirmsEveryAction(plain, 'community-trusted')).toBe(false)
    // Reading never asks.
    expect(check(risky, 'observe')).toEqual({ ok: true, confirm: false })
  })

  it('matches apps and URLs', () => {
    expect(appAllowed([], null)).toBe(true)
    expect(appAllowed(['gimp'], 'gimp-2.10.exe')).toBe(true)
    expect(appAllowed(['gimp'], 'chrome')).toBe(false)
    expect(urlAllowed(['https://example.com/docs/*'], 'https://example.com/docs/a')).toBe(true)
    expect(urlAllowed(['https://example.com/docs/*'], 'https://example.com/admin')).toBe(false)
    expect(urlAllowed(['https://example.com'], 'http://example.com')).toBe(false)
    expect(urlAllowed(['https://example.com'], 'not a url')).toBe(false)
  })

  it('lets a skill use only its own connectors', () => {
    expect(check(skill({ connectors: ['github'] }), 'mcp__github__search').ok).toBe(true)
    const other = check(skill({ connectors: ['github'] }), 'mcp__jira__find')
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.spoken).toMatch(/not allowed to use the jira connector/)
    expect(check(skill(), 'mcp__github__search').ok).toBe(false)
  })
})
