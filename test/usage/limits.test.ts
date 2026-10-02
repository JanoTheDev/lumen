import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { UsageLimitsConfig } from '../../src/shared/config'
import { recordCall, setLedgerDir } from '../../src/main/usage/ledger'
import {
  canStartRun,
  checkRunLimit,
  installUsageLimits,
  limitState,
  resetUsageLimits,
  setLimitsStatePath,
  type LimitScope
} from '../../src/main/usage/limits'

let dir: string
let limits: UsageLimitsConfig
let notices: Array<{ text: string; scope: LimitScope }>
let warnings: string[]
let now: Date
let buddyCap: { perMonthUsd?: number; perMonthTokens?: number }

const call = (usd: number, extra: Record<string, unknown> = {}): void => {
  recordCall({
    provider: 'anthropic',
    model: 'm',
    in: 100,
    out: 100,
    usd,
    origin: 'background',
    t: now.getTime(),
    ...extra
  })
}

function install(): void {
  installUsageLimits({
    limits: () => limits,
    buddy: (id) => (id === 'inbox' ? { name: 'Inbox Buddy', ...buddyCap } : null),
    automationName: (id) => (id === 'au_morning' ? 'Morning brief' : undefined),
    notify: (text, scope) => notices.push({ text, scope }),
    warn: (text) => warnings.push(text),
    now: () => now
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-overlay-limits-'))
  setLedgerDir(dir)
  setLimitsStatePath(join(dir, 'limits-state.json'))
  limits = { automations: {} }
  notices = []
  warnings = []
  buddyCap = {}
  now = new Date(2026, 9, 10, 12)
  install()
})

afterEach(() => {
  resetUsageLimits()
  setLimitsStatePath(null)
  setLedgerDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('usage limits', () => {
  it('without caps nothing is paused or noticed', () => {
    call(50)
    expect(limitState({ kind: 'overall' }).level).toBe('none')
    expect(canStartRun({ automationId: 'au_morning' })).toEqual({ ok: true })
    expect(notices).toEqual([])
  })

  it('warns once at 80% and pauses once at 100% overall', () => {
    limits = { monthlyUsd: 10, automations: {} }
    call(5)
    expect(notices).toEqual([])
    call(3.5)
    call(0.1)
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toMatch(/85% of your monthly limit \(\$8\.50 of \$10\.00\)/)
    call(2)
    call(1)
    expect(notices).toHaveLength(2)
    expect(notices[1].text).toMatch(/^Paused: monthly limit reached/)
    const r = canStartRun({})
    expect(r.ok).toBe(false)
    expect(checkRunLimit({ origin: 'routine', routineId: 'au_morning' }).ok).toBe(false)
    expect(checkRunLimit({ origin: 'buddy', buddyId: 'inbox' }).ok).toBe(false)
    // The user's own background tasks, helpers and own-runner rows are never refused.
    expect(checkRunLimit({ origin: 'voice' }).ok).toBe(true)
    expect(checkRunLimit({ origin: 'routine', routineId: 'au_morning', parentId: 'x' }).ok).toBe(
      true
    )
    expect(checkRunLimit({ origin: 'routine', run: () => {} }).ok).toBe(true)
  })

  it('warns the user once past the overall cap, without blocking', () => {
    limits = { monthlyUsd: 1, automations: {} }
    call(2)
    call(0.1, { origin: 'user-direct' })
    call(0.1, { origin: 'user-direct' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/keep answering you/)
  })

  it('counts tokens for free models', () => {
    limits = { monthlyTokens: 1000, automations: {} }
    for (let i = 0; i < 4; i++) call(0, { free: true })
    expect(limitState({ kind: 'overall' }).level).toBe('warn')
    call(0, { free: true })
    expect(limitState({ kind: 'overall' }).level).toBe('paused')
    expect(notices.map((n) => n.text)).toEqual([
      expect.stringMatching(/80%.*800 tokens of 1k tokens/),
      expect.stringMatching(/1k tokens of 1k tokens/)
    ])
  })

  it('pauses one automation without pausing others', () => {
    limits = { automations: { au_morning: { usd: 1 } } }
    call(1.2, { automationId: 'au_morning', origin: 'automation' })
    expect(notices.map((n) => n.text)).toEqual([
      'The automation “Morning brief” is paused: monthly limit reached ($1.20 of $1.00).'
    ])
    expect(canStartRun({ automationId: 'au_morning' }).ok).toBe(false)
    expect(canStartRun({ automationId: 'au_other' }).ok).toBe(true)
    // A raised cap lets it run again.
    limits = { automations: { au_morning: { usd: 5 } } }
    expect(canStartRun({ automationId: 'au_morning' }).ok).toBe(true)
  })

  it('uses the buddy budget for buddies', () => {
    buddyCap = { perMonthUsd: 2 }
    call(1.7, { buddyId: 'inbox', origin: 'buddy' })
    expect(notices[0].text).toMatch(/^Inbox Buddy has used 85% of its monthly limit/)
    expect(canStartRun({ buddyId: 'inbox' }).ok).toBe(true)
    call(0.5, { buddyId: 'inbox', origin: 'buddy' })
    const r = canStartRun({ buddyId: 'inbox' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Inbox Buddy is paused/)
  })

  it('keeps the notice state across restarts and starts over next month', () => {
    limits = { monthlyUsd: 10, automations: {} }
    call(9)
    expect(notices).toHaveLength(1)
    const saved = JSON.parse(readFileSync(join(dir, 'limits-state.json'), 'utf8'))
    expect(saved).toMatchObject({ month: '2026-10', warned: ['all'] })
    resetUsageLimits()
    install()
    call(0.1)
    expect(notices).toHaveLength(1)
    now = new Date(2026, 10, 2, 9)
    expect(canStartRun({}).ok).toBe(true)
    call(8.5)
    expect(notices).toHaveLength(2)
  })

  it('leaves Claude Code lines out', () => {
    limits = { monthlyUsd: 1, automations: {} }
    call(5, { billing: 'claude-code', provider: 'claude-code' })
    expect(limitState({ kind: 'overall' }).usd).toBe(0)
    expect(notices).toEqual([])
  })

  it('warns the user again after a raised overall cap is passed (review L5)', () => {
    limits = { monthlyUsd: 1, automations: {} }
    call(2)
    call(0.1, { origin: 'user-direct' })
    expect(warnings).toHaveLength(1)
    limits = { monthlyUsd: 10, automations: {} }
    call(0.1)
    call(8)
    call(0.1, { origin: 'user-direct' })
    expect(warnings).toHaveLength(2)
  })

  it('counts paid calls with no known price at the fallback rate (review M5)', () => {
    limits = { monthlyUsd: 1, automations: { au_morning: { usd: 1 } } }
    // 1M input tokens at the Sonnet 5.5 rate ($2 / MTok) is past a $1 cap.
    call(0, {
      priced: false,
      free: false,
      in: 1_000_000,
      out: 0,
      automationId: 'au_morning',
      origin: 'automation'
    })
    const st = limitState({ kind: 'automation', id: 'au_morning' })
    expect(st).toMatchObject({ level: 'paused', usd: 2, estimated: 1 })
    expect(canStartRun({ automationId: 'au_morning' }).ok).toBe(false)
    // A free or local model stays $0 (its tokens count only toward a token cap).
    limits = { monthlyUsd: 1, automations: {} }
    resetUsageLimits()
    install()
    expect(limitState({ kind: 'buddy', id: 'inbox' })).toMatchObject({ usd: 0, estimated: 0 })
    call(0, { priced: false, free: true, in: 1_000_000, buddyId: 'inbox' })
    expect(limitState({ kind: 'buddy', id: 'inbox' })).toMatchObject({ usd: 0, estimated: 0 })
  })
})
