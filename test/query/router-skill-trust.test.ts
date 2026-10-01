import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const skills = vi.hoisted(() => ({
  trust: {} as Record<string, string>
}))

vi.mock('../../src/main/skills', () => ({
  skillIndex: () => '',
  getSkillRegistry: () => ({
    get: (name: string) => (skills.trust[name] ? { name } : null),
    trustOf: (s: { name: string }) => skills.trust[s.name]
  })
}))

import { routeWithLlm, routerMaySelectSkill, type Route } from '../../src/main/query/router'
import { setProvider } from '../../src/main/ai/providers'
import type { LlmProvider } from '../../src/main/ai/providers/types'
import { setConfigDir } from '../../src/main/config'
import { tempDir } from '../helpers/fixtures'

const base: Route = {
  mode: 'plan',
  needsScreen: false,
  needsUia: false,
  appSwitch: false,
  confidence: 0.9
}

function provider(data: unknown): LlmProvider {
  return {
    id: 'anthropic',
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('router must not stream')
    },
    complete: (async () => ({
      data,
      text: JSON.stringify(data),
      model: 'claude-haiku-4-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
    })) as LlmProvider['complete'],
    warmup: async () => {}
  }
}

describe('router skill route and skill trust', () => {
  const key = process.env.ANTHROPIC_API_KEY
  let cleanup: () => void
  beforeEach(() => {
    const t = tempDir()
    cleanup = t.cleanup
    setConfigDir(t.dir)
    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    skills.trust = {
      mine: 'mine',
      built: 'builtin',
      trusted: 'community-trusted',
      shady: 'community-untrusted'
    }
  })
  afterEach(() => {
    setProvider('anthropic', null)
    setConfigDir(null)
    cleanup()
    process.env.ANTHROPIC_API_KEY = key
    vi.restoreAllMocks()
  })

  it('lets only builtin, own and trusted skills be picked by the router', () => {
    expect(routerMaySelectSkill('mine')).toBe(true)
    expect(routerMaySelectSkill('built')).toBe(true)
    expect(routerMaySelectSkill('trusted')).toBe(true)
    expect(routerMaySelectSkill('shady')).toBe(false)
    expect(routerMaySelectSkill('missing')).toBe(false)
  })

  it('drops an untrusted community skill from the route but keeps the mode', async () => {
    setProvider('anthropic', provider({ ...base, skill: { name: 'shady' } }))
    const route = await routeWithLlm({ utterance: 'tidy up', activeWindow: '', guideActive: false })
    expect(route?.mode).toBe('plan')
    expect(route?.skill).toBeUndefined()
  })

  it('keeps a trusted skill on the route', async () => {
    setProvider('anthropic', provider({ ...base, skill: { name: 'trusted' } }))
    const route = await routeWithLlm({ utterance: 'tidy up', activeWindow: '', guideActive: false })
    expect(route?.skill?.name).toBe('trusted')
  })
})
