import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mainModeFor,
  normalizeRoute,
  prefilter,
  routeLocal,
  routeSchema,
  routeWithLlm,
  ROUTER_MAX_TOKENS,
  setLocalGrammar,
  type PrefilterHit,
  type Route
} from '../../src/main/query/router'
import { ROUTER_PROMPT, routerTurn } from '../../src/main/ai/prompts/router'
import { setProvider } from '../../src/main/ai/providers'
import type {
  CompleteResult,
  LlmProvider,
  StructuredRequest
} from '../../src/main/ai/providers/types'
import { setConfigDir } from '../../src/main/config'
import { tempDir } from '../helpers/fixtures'

interface Case {
  id: number
  utterance: string
  foreground: string
  guideActive: boolean
  hasLastGuide: boolean
  hasLastTask: boolean
  prefilter?: string
  mode?: string
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../eval/router/utterances.json'), 'utf8')
) as { cases: Case[] }

function hitLabel(hit: PrefilterHit | null): string | null {
  if (!hit) return null
  return hit.kind === 'guide-nav' ? `guide-nav:${hit.command}` : hit.kind
}

describe('router eval fixture', () => {
  it('has at least 150 labelled cases, each with a mode or a prefilter label', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(150)
    for (const c of fixture.cases) expect(!!c.mode !== !!c.prefilter).toBe(true)
  })

  it('includes the audit failure cases', () => {
    const find = (u: string, extra: Partial<Case> = {}): Case | undefined =>
      fixture.cases.find(
        (c) =>
          c.utterance === u && Object.entries(extra).every(([k, v]) => c[k as keyof Case] === v)
      )
    expect(find("what's the weather", { guideActive: true })?.mode).toBe('answer')
    expect(find('go back to gmail')?.mode).toBe('action')
    expect(find('close this tab')?.mode).toBe('action')
    expect(find('how do I open settings')?.mode).toBe('guide')
  })
})

describe('prefilter on the fixture', () => {
  const local = fixture.cases.filter((c) => c.prefilter)
  const routed = fixture.cases.filter((c) => c.mode)

  it.each(local.map((c) => [c.utterance, c.prefilter, c] as const))(
    'handles %j locally as %s',
    (_u, expected, c) => {
      expect(hitLabel(prefilter(c.utterance, c))).toBe(expected)
    }
  )

  it.each(routed.map((c) => [c.utterance, c.guideActive, c] as const))(
    'leaves %j (guide active: %s) to the router',
    (_u, _g, c) => {
      expect(prefilter(c.utterance, c)).toBeNull()
    }
  )
})

describe('prefilter', () => {
  const idle = { guideActive: false, hasLastGuide: false, hasLastTask: false }

  it('ignores guide nav when no guide is active', () => {
    expect(prefilter('next', idle)).toBeNull()
    expect(prefilter('back', idle)).toBeNull()
  })

  it('needs a previous guide for save/replay and a previous task for "do it"', () => {
    expect(prefilter('replay the guide', idle)).toBeNull()
    expect(prefilter('save this guide', idle)).toBeNull()
    expect(prefilter('do it', idle)).toBeNull()
    expect(prefilter('do it', { ...idle, hasLastTask: true })).toEqual({ kind: 'continuation' })
  })

  it('requires the word guide and a whole utterance for save/replay', () => {
    const s = { ...idle, hasLastGuide: true }
    expect(prefilter('one more time', s)).toBeNull()
    expect(prefilter('what was the last guide about', s)).toBeNull()
    expect(prefilter('can you save this document', s)).toBeNull()
    expect(prefilter('save guide as Inbox Zero.', s)).toEqual({
      kind: 'guide-save',
      name: 'Inbox Zero'
    })
  })

  it('treats long utterances as real queries', () => {
    expect(prefilter(`stop ${'x'.repeat(100)}`, idle)).toBeNull()
  })
})

describe('routeLocal', () => {
  afterEach(() => setLocalGrammar(null))
  const state = { guideActive: true, hasLastGuide: true, hasLastTask: true }

  it('runs the injected local grammar first', () => {
    setLocalGrammar((u) => (u === 'next' ? { response: { from: 'grammar' } } : null))
    const handle = vi.fn()
    expect(routeLocal('next', state, handle)).toEqual({ from: 'grammar' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('defaults to a no-op grammar and dispatches prefilter hits', () => {
    const handle = vi.fn(() => 'handled')
    expect(routeLocal('next', state, handle)).toBe('handled')
    expect(handle).toHaveBeenCalledWith({ kind: 'guide-nav', command: 'next' })
  })

  it('leaves continuations and real queries to the pipeline', () => {
    const handle = vi.fn()
    expect(routeLocal('do it', state, handle)).toBeUndefined()
    expect(routeLocal("what's the weather", state, handle)).toBeUndefined()
    expect(handle).not.toHaveBeenCalled()
  })
})

const base: Route = {
  mode: 'answer',
  needsScreen: false,
  needsUia: false,
  appSwitch: false,
  confidence: 0.9
}

describe('normalizeRoute', () => {
  it('fills the app URL from the table and ignores a model URL for known apps', () => {
    const r = normalizeRoute({
      ...base,
      mode: 'action',
      appSwitch: true,
      targetApp: { name: 'Gmail', url: 'https://evil.example/' }
    })
    expect(r.targetApp).toEqual({ name: 'Gmail', url: 'https://mail.google.com/' })
    expect(r.appSwitch).toBe(true)
  })

  it('keeps only https model URLs for unknown apps', () => {
    const ok = normalizeRoute({ ...base, targetApp: { name: 'Figma', url: 'https://figma.com/' } })
    expect(ok.targetApp?.url).toBe('https://figma.com/')
    const bad = normalizeRoute({ ...base, targetApp: { name: 'Thing', url: 'file:///c:/x.exe' } })
    expect(bad.targetApp).toEqual({ name: 'Thing' })
  })

  it('drops appSwitch without a target app', () => {
    expect(normalizeRoute({ ...base, appSwitch: true }).appSwitch).toBe(false)
  })

  it('keeps 2-4 split questions for answer mode only', () => {
    expect(normalizeRoute({ ...base, parallelSplit: ['a?', ' b? '] }).parallelSplit).toEqual([
      'a?',
      'b?'
    ])
    expect(normalizeRoute({ ...base, parallelSplit: ['a?'] }).parallelSplit).toBeUndefined()
    expect(
      normalizeRoute({ ...base, parallelSplit: ['1', '2', '3', '4', '5'] }).parallelSplit
    ).toBeUndefined()
    expect(
      normalizeRoute({ ...base, mode: 'action', parallelSplit: ['open a', 'open b'] }).parallelSplit
    ).toBeUndefined()
  })

  it('clamps confidence and forces the screen for screen modes', () => {
    expect(normalizeRoute({ ...base, confidence: 7 }).confidence).toBe(1)
    expect(normalizeRoute({ ...base, mode: 'locate' }).needsScreen).toBe(true)
    expect(normalizeRoute({ ...base, mode: 'action' }).needsScreen).toBe(false)
  })
})

describe('mainModeFor', () => {
  it('passes the routed mode unless unsure or handled by another path', () => {
    expect(mainModeFor(base)).toBe('answer')
    expect(mainModeFor({ ...base, mode: 'describe' })).toBe('answer')
    expect(mainModeFor({ ...base, mode: 'plan' })).toBeNull()
    expect(mainModeFor({ ...base, mode: 'guide', confidence: 0.3 })).toBeNull()
    expect(mainModeFor(null)).toBeNull()
  })
})

describe('router prompt', () => {
  it('is stable and carries the failure cases as examples', () => {
    expect(ROUTER_PROMPT).toContain('"go back to gmail"')
    expect(ROUTER_PROMPT).toContain('"what\'s the weather" [guide_active]')
    expect(ROUTER_PROMPT).not.toMatch(/SYSTEM OVERRIDE|\d{4}-\d{2}-\d{2}/)
  })

  it('puts the context in the user turn', () => {
    const turn = routerTurn({
      utterance: 'next',
      activeWindow: 'Blender',
      guideActive: true,
      lastMode: 'guide'
    })
    expect(turn).toContain('foreground: Blender')
    expect(turn).toContain('guide_active: true')
    expect(turn).toContain('last_mode: guide')
    expect(turn).toContain('<utterance>next</utterance>')
  })
})

describe('routeWithLlm', () => {
  const key = process.env.ANTHROPIC_API_KEY
  let cleanup: () => void
  beforeEach(() => {
    const t = tempDir()
    cleanup = t.cleanup
    setConfigDir(t.dir)
    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    setProvider('anthropic', null)
    setConfigDir(null)
    cleanup()
    process.env.ANTHROPIC_API_KEY = key
    vi.restoreAllMocks()
  })

  function provider(
    complete: (
      req: StructuredRequest<unknown>,
      signal?: AbortSignal
    ) => Promise<CompleteResult<unknown>>
  ): LlmProvider {
    return {
      id: 'anthropic',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('router must not stream')
      },
      complete: vi.fn(complete) as LlmProvider['complete'],
      warmup: async () => {}
    }
  }

  const reply = (data: unknown, text = JSON.stringify(data)): CompleteResult<unknown> => ({
    data,
    text,
    model: 'claude-haiku-4-5',
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
  })

  const input = { utterance: 'go back to gmail', activeWindow: 'VS Code', guideActive: false }

  it('calls the fast model with the router schema and a small budget', async () => {
    const p = provider(async () =>
      reply({ ...base, mode: 'action', appSwitch: true, targetApp: { name: 'gmail' } })
    )
    setProvider('anthropic', p)
    const route = await routeWithLlm(input)
    expect(route).toMatchObject({
      mode: 'action',
      appSwitch: true,
      targetApp: { url: 'https://mail.google.com/' }
    })
    const req = (p.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StructuredRequest<unknown>
    expect(req.model).toBe('claude-haiku-4-5')
    expect(req.maxTokens).toBe(ROUTER_MAX_TOKENS)
    expect(req.schema).toBe(routeSchema)
    expect(req.images ?? []).toHaveLength(0)
    expect(req.system[0]).toEqual({ text: ROUTER_PROMPT, cacheable: true })
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/\[time\].*router \d+ms/))
  })

  it('parses the text when structured data is missing', async () => {
    setProvider(
      'anthropic',
      provider(async () => reply(null, JSON.stringify({ ...base, mode: 'guide' })))
    )
    expect((await routeWithLlm(input))?.mode).toBe('guide')
  })

  it('returns null on an unusable reply or a provider error', async () => {
    setProvider(
      'anthropic',
      provider(async () => reply(null, 'no idea'))
    )
    expect(await routeWithLlm(input)).toBeNull()
    setProvider(
      'anthropic',
      provider(async () => Promise.reject(new Error('529 overloaded')))
    )
    expect(await routeWithLlm(input)).toBeNull()
  })

  it('throws when the caller cancels', async () => {
    const ctrl = new AbortController()
    setProvider(
      'anthropic',
      provider(
        (_req, signal) =>
          new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
      )
    )
    const p = routeWithLlm(input, ctrl.signal)
    ctrl.abort(new Error('Cancelled'))
    await expect(p).rejects.toThrow('Cancelled')
  })
})
