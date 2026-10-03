import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildReport,
  callsFor,
  CSV_COLUMNS,
  dayBars,
  MAX_CALLS,
  rangeBounds,
  taskCosts,
  automationCosts,
  usageCsv,
  usageForTasks,
  usageReport
} from '../../src/main/usage/report'
import {
  importRows,
  queryUsage,
  recordCall,
  setLedgerDir,
  type UsageRow
} from '../../src/main/usage/ledger'

const at = (iso: string, h = 12): number =>
  new Date(`${iso}T${String(h).padStart(2, '0')}:00:00`).getTime()

const row = (p: Partial<UsageRow>): UsageRow => ({
  t: at('2026-10-02'),
  provider: 'anthropic',
  model: 'claude-x',
  in: 100,
  out: 50,
  cacheRead: 0,
  cacheWrite: 0,
  searches: 0,
  audioSec: 0,
  usd: 0.01,
  priced: true,
  free: false,
  origin: 'user-direct',
  feature: 'answer',
  ...p
})

describe('usage report', () => {
  it('range bounds start at local midnight', () => {
    const now = at('2026-10-02', 15)
    expect(rangeBounds('today', now).from).toBe(at('2026-10-02', 0))
    expect(rangeBounds('7d', now).from).toBe(at('2026-09-26', 0))
    expect(rangeBounds('30d', now).from).toBe(at('2026-09-03', 0))
    expect(rangeBounds('month', now).from).toBe(at('2026-10-01', 0))
    expect(rangeBounds('today', now).to).toBe(now + 1)
  })

  it('totals, tables with names, helpers under their task, Claude Code apart', () => {
    const rows = [
      row({
        origin: 'automation',
        automationId: 'a1',
        taskId: 'bg_aaaa',
        feature: 'agent-step',
        usd: 0.05
      }),
      row({ origin: 'subagent', taskId: 'bg_aaaa', feature: 'subagent-reader', usd: 0.02 }),
      row({ origin: 'background', taskId: 'bg_child', parentTaskId: 'bg_aaaa', usd: 0.01 }),
      row({ provider: 'local', model: 'qwen', usd: 0, free: true, cacheRead: 300 }),
      row({ provider: 'x', model: 'y', usd: 0, priced: false }),
      row({
        provider: 'claude-code',
        model: 'opus',
        billing: 'claude-code',
        ccSession: 'cc1',
        usd: 1.5
      })
    ]
    const bounds = { from: at('2026-10-01', 0), to: at('2026-10-03', 0) }
    const r = buildReport(rows, '7d', bounds, {
      automation: (id) => (id === 'a1' ? 'Morning mail' : undefined),
      task: () => {
        throw new Error('not ready')
      }
    })
    expect(r.sums.calls).toBe(5)
    expect(r.sums.usd).toBeCloseTo(0.08)
    expect(r.sums.unpriced).toBe(1)
    expect(r.sums.free).toBe(1)
    expect(r.cacheHitRate).toBeCloseTo(300 / 800)
    expect(r.tables.automation).toEqual([
      expect.objectContaining({ key: 'a1', name: 'Morning mail' })
    ])
    // the child task's spend counts toward its parent; a failing lookup shows the id
    expect(r.tables.task).toHaveLength(1)
    expect(r.tables.task[0]).toMatchObject({ key: 'bg_aaaa', name: 'bg_aaaa' })
    expect(r.tables.task[0].sums.usd).toBeCloseTo(0.08)
    expect(r.tables.model[0].key).toBe('anthropic/claude-x')
    expect(r.tables.feature.map((x) => x.key)).toContain('subagent-reader')
    expect(r.claudeCode?.sums.usd).toBe(1.5)
    expect(r.claudeCode?.sessions[0].key).toBe('cc1')
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-01', '2026-10-02'])
    expect(r.days[1].usd.automations).toBeCloseTo(0.05)
    expect(r.days[1].usd.tasks).toBeCloseTo(0.02)
    expect(r.days[1].tokens.you).toBe(450 + 150)
  })

  it('no Claude Code group without its lines; top 20 by spend', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ feature: `f${i}`, usd: i / 100 }))
    const r = buildReport(rows, 'today', rangeBounds('today', at('2026-10-02', 20)))
    expect(r.claudeCode).toBeNull()
    expect(r.tables.feature).toHaveLength(20)
    expect(r.tables.feature[0].key).toBe('f24')
  })

  it('day bars fill empty days and skip external lines', () => {
    const bars = dayBars(
      [row({ billing: 'claude-code', usd: 9 }), row({ t: at('2026-09-30'), origin: 'buddy' })],
      at('2026-09-29', 0),
      at('2026-10-02', 13)
    )
    expect(bars.map((b) => b.day)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
    expect(bars[1].usd.buddies).toBeCloseTo(0.01)
    expect(bars[3].usd.you).toBe(0)
  })

  it("buckets a buddy's or automation's helpers with their owner (review L6)", () => {
    const rows = [
      row({ origin: 'subagent', buddyId: 'inbox' }),
      row({ origin: 'subagent', automationId: 'au_1' }),
      row({ origin: 'subagent' })
    ]
    const bars = dayBars(rows, at('2026-10-02', 0), at('2026-10-02', 13))
    expect(bars[0].usd).toMatchObject({ buddies: 0.01, automations: 0.01, tasks: 0.01 })
    expect(callsFor(rows, { group: 'bucket', key: 'buddies' }).total).toBe(1)
  })

  it('drill-down: newest first, capped, by group', () => {
    const rows = Array.from({ length: MAX_CALLS + 5 }, (_, i) =>
      row({ t: at('2026-10-02') + i, taskId: 'bg_aaaa' })
    )
    const c = callsFor(rows, { group: 'task', key: 'bg_aaaa' })
    expect(c.total).toBe(MAX_CALLS + 5)
    expect(c.rows).toHaveLength(MAX_CALLS)
    expect(c.rows[0].t).toBeGreaterThan(c.rows[1].t)
    expect(callsFor(rows, { group: 'bucket', key: 'you' }).total).toBe(MAX_CALLS + 5)
    expect(callsFor(rows, { group: 'day', key: '2026-10-02' }).total).toBe(MAX_CALLS + 5)
    expect(callsFor(rows, { group: 'claude', key: 'unknown' }).total).toBe(0)
    const cc = [row({ billing: 'claude-code', ccSession: 's1' })]
    expect(callsFor(cc, { group: 'claude', key: 's1' }).total).toBe(1)
    expect(callsFor(cc, { group: 'model', key: 'anthropic/claude-x' }).total).toBe(0)
  })

  it('task and automation costs', () => {
    const rows = [
      row({ taskId: 'bg_p', usd: 0.1 }),
      row({ taskId: 'bg_c', parentTaskId: 'bg_p', usd: 0.2, priced: false }),
      row({ automationId: 'a1', usd: 0.3 }),
      row({ taskId: 'bg_p', billing: 'claude-code', usd: 5 })
    ]
    const t = taskCosts(rows, ['bg_p', 'bg_c', 'bg_none'])
    expect(t.bg_p.usd).toBeCloseTo(0.3)
    expect(t.bg_p.calls).toBe(2)
    expect(t.bg_p.unpriced).toBe(1)
    expect(t.bg_p.tokens).toBe(300)
    expect(t.bg_c.usd).toBeCloseTo(0.2)
    expect(t.bg_none).toBeUndefined()
    expect(automationCosts(rows)).toEqual({ a1: { usd: 0.3, tokens: 150, calls: 1, unpriced: 0 } })
  })

  it('csv: counts and ids only, formula guard, BOM', () => {
    const csv = usageCsv([
      row({ feature: '=HYPERLINK("x")', taskId: 'bg_aaaa', role: 'main' }),
      row({ billing: 'claude-code', ccSession: '+cc' })
    ])
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines[0]).toBe(CSV_COLUMNS.join(','))
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`)
    expect(lines[1]).toContain('bg_aaaa')
    expect(lines[1]).toContain(',lumen,')
    expect(lines[2]).toContain(',claude-code,')
    expect(lines[2].endsWith("'+cc")).toBe(true)
  })
})

describe('usage report from the ledger', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-overlay-report-'))
    setLedgerDir(dir)
  })
  afterEach(() => {
    setLedgerDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads recorded calls', () => {
    const now = Date.now()
    recordCall({ provider: 'openai', model: 'm', in: 10, out: 5, usd: 0.002, taskId: 'bg_rrrr' })
    const r = usageReport('today', {}, now + 10)
    expect(r.sums.calls).toBe(1)
    expect(usageForTasks(['bg_rrrr'], now + 10).bg_rrrr.tokens).toBe(15)
  })

  it('task costs follow new lines and match a full scan', () => {
    const now = Date.now()
    const ids = ['bg_a', 'bg_b', 'bg_c']
    recordCall({ provider: 'p', model: 'm', in: 10, out: 5, usd: 0.01, taskId: 'bg_a' })
    expect(usageForTasks(ids, now + 10).bg_a.calls).toBe(1)
    recordCall({
      provider: 'p',
      model: 'm',
      in: 3,
      out: 2,
      usd: 0.02,
      taskId: 'bg_b',
      parentTaskId: 'bg_a'
    })
    recordCall({
      provider: 'p',
      model: 'm',
      in: 1,
      out: 1,
      usd: 0.03,
      taskId: 'bg_a',
      parentTaskId: 'bg_a'
    })
    recordCall({
      provider: 'p',
      model: 'm',
      in: 9,
      out: 9,
      usd: 1,
      taskId: 'bg_c',
      billing: 'claude-code'
    })
    recordCall({
      provider: 'p',
      model: 'm',
      in: 4,
      out: 4,
      usd: 0.04,
      origin: 'subagent',
      taskId: 'bg_c'
    })
    const live = usageForTasks(ids, now + 20)
    expect(live).toEqual(taskCosts(queryUsage({ from: 0, to: now + 1000 }), ids))
    expect(live.bg_a).toMatchObject({ calls: 3, tokens: 22 })
    expect(live.bg_c.calls).toBe(1)
    importRows([row({ t: now, taskId: 'bg_b' })])
    expect(usageForTasks(['bg_b'], now + 30).bg_b.calls).toBe(2)
  })
})
