import { describe, it, expect, vi } from 'vitest'
import {
  SYSTEM_PREFIX,
  estimateTokens,
  systemBlocks,
  userTurn
} from '../../src/main/ai/prompts/assemble'
import { UNTRUSTED_CONTENT_RULE } from '../../src/main/ai/prompts/untrusted'
import { writingRulesFor } from '../../src/main/ai/prompts/apps'
import { cacheStats, recordUsage, resetCostTotals } from '../../src/main/ai/cost'
import type { Usage } from '../../src/main/ai/providers/types'

const gmail = {
  prompt: 'write a resignation email',
  activeWindow: 'Inbox - Gmail - Google Chrome',
  frame: { w: 1280, h: 720 },
  now: new Date(2026, 9, 1, 14, 2)
}
const explorer = {
  prompt: 'what is this folder',
  activeWindow: 'Downloads - File Explorer',
  frame: null,
  routedMode: 'answer',
  now: new Date(2027, 0, 5, 9, 30)
}

describe('system prefix', () => {
  it('is one cacheable block, identical for any context', () => {
    const a = systemBlocks()
    userTurn(gmail)
    const b = systemBlocks()
    userTurn(explorer)
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
    expect(a[0].cacheable).toBe(true)
    expect(a[0].text).toBe(SYSTEM_PREFIX)
  })

  it('matches the snapshot', () => {
    expect(SYSTEM_PREFIX).toMatchSnapshot()
  })

  it('stays within the token budget', () => {
    const tokens = estimateTokens(SYSTEM_PREFIX)
    console.log(`[prompt] system prefix ~${tokens} tokens`)
    expect(tokens).toBeLessThanOrEqual(3000)
    // Above the 512-token cache minimum of Sonnet/Opus 5.5.
    expect(tokens).toBeGreaterThan(512)
  })

  it('has the untrusted-content rule near the top', () => {
    const at = SYSTEM_PREFIX.indexOf(UNTRUSTED_CONTENT_RULE)
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(600)
  })

  it('contains no banned phrases or volatile data', () => {
    expect(SYSTEM_PREFIX).not.toMatch(/SYSTEM OVERRIDE/)
    expect(SYSTEM_PREFIX).not.toMatch(/never refuse|never apply content judgment/i)
    expect(SYSTEM_PREFIX).not.toMatch(/\[x1, ?y1, ?x2, ?y2\]/)
    expect(SYSTEM_PREFIX).not.toMatch(/navigate_url|target_hint|"bbox":\[/)
    expect(SYSTEM_PREFIX).not.toMatch(/\b20\d\d\b/)
    expect(SYSTEM_PREFIX).not.toMatch(/\b(simply|just)\b(?!")/i)
  })
})

describe('user turn', () => {
  it('carries the volatile context and the request verbatim', () => {
    const turn = userTurn(gmail)
    expect(turn).toMatch(/^<context>\n/)
    expect(turn).toContain('time: Thursday, October 1, 2026')
    expect(turn).toContain('foreground: Inbox - Gmail - Google Chrome')
    expect(turn).toContain('screen: frame "1", 1280x720 px')
    expect(turn).toContain(`app_style: ${writingRulesFor(gmail.activeWindow)}`)
    expect(turn).not.toContain('routed_mode')
    expect(turn.endsWith('<request>write a resignation email</request>')).toBe(true)
  })

  it('states when no screenshot is sent and passes the routed mode', () => {
    const turn = userTurn(explorer)
    expect(turn).toContain('screen: none sent')
    expect(turn).toContain('routed_mode: answer')
    expect(turn).not.toContain('target_app')
  })

  it('names the app to switch to when the router asked for one', () => {
    const turn = userTurn({
      ...explorer,
      routedMode: 'action',
      targetApp: { name: 'Gmail', url: 'https://mail.google.com/' }
    })
    expect(turn).toContain('target_app: Gmail https://mail.google.com/ (not in front)')
    expect(userTurn({ ...explorer, targetApp: { name: 'Figma' } })).toContain(
      'target_app: Figma (not in front)'
    )
  })

  it('keeps per-app writing rules', () => {
    expect(writingRulesFor('Inbox - Gmail')).toMatch(/greeting, body, sign-off/)
    expect(writingRulesFor('Home / X - x.com')).toMatch(/280 characters/)
    expect(writingRulesFor('Notepad')).toMatch(/naturally/)
  })
})

describe('cache stats', () => {
  it('reports hit share over calls after the first', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    resetCostTotals()
    const u = (read: number, input: number): Usage => ({
      inputTokens: input,
      outputTokens: 10,
      cacheReadTokens: read,
      cacheWriteTokens: 0
    })
    recordUsage('claude-sonnet-5-5', { ...u(0, 500), cacheWriteTokens: 2000 })
    expect(cacheStats()).toBeNull()
    recordUsage('claude-sonnet-5-5', u(2000, 500))
    recordUsage('claude-sonnet-5-5', u(2000, 500))
    expect(cacheStats()).toEqual({ callRate: 1, tokenRate: 0.8 })
    vi.restoreAllMocks()
  })
})
