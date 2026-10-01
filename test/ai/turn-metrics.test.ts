import { describe, expect, it } from 'vitest'
import { TurnMetrics, type TurnRecord } from '../../src/main/ai/turn-metrics'
// @ts-expect-error plain JS script without types
import { formatMarkdown, parseLog, summarize } from '../../scripts/perf-baseline.mjs'

function clock(): { now: () => number; at: (t: number) => void } {
  let t = 0
  return { now: () => t, at: (v) => (t = v) }
}

describe('TurnMetrics', () => {
  it('measures speech → query → first byte → done with the turn cost', () => {
    const c = clock()
    const out: TurnRecord[] = []
    const m = new TurnMetrics(c.now, (r) => out.push(r))
    c.at(1000)
    m.speechEnded()
    c.at(1600)
    m.started('t1', 'what is this')
    c.at(2400)
    m.firstByte('t1')
    c.at(2500)
    m.firstByte('t1')
    c.at(3600)
    m.finished('t1', 'done', {
      mode: 'answer',
      model: 'claude-sonnet-5-5',
      cost: { usd: 0.01, calls: 2, inputTokens: 900, outputTokens: 80, cacheReadTokens: 2000 }
    })
    expect(out).toEqual([
      {
        mode: 'answer',
        outcome: 'done',
        model: 'claude-sonnet-5-5',
        speechToQueryMs: 600,
        firstByteMs: 800,
        totalMs: 2000,
        promptChars: 12,
        calls: 2,
        inputTokens: 900,
        outputTokens: 80,
        cacheReadTokens: 2000,
        cacheWriteTokens: 0,
        usd: 0.01
      }
    ])
  })

  it('links one speech end to one query and ignores typed or stale ones', () => {
    const c = clock()
    const out: TurnRecord[] = []
    const m = new TurnMetrics(c.now, (r) => out.push(r))
    m.speechEnded()
    c.at(500)
    m.started('a', 'x')
    m.started('b', 'y')
    m.finished('a', 'cancelled')
    m.finished('b', 'failed')
    m.finished('b', 'failed')
    m.speechEnded()
    c.at(60_000)
    m.started('c', 'z')
    m.finished('c', 'done', { mode: 'locate' })
    expect(out.map((r) => [r.outcome, r.speechToQueryMs])).toEqual([
      ['cancelled', 500],
      ['failed', undefined],
      ['done', undefined]
    ])
    expect(out[0].mode).toBe('unknown')
  })
})

describe('perf-baseline script', () => {
  const line = (r: Partial<TurnRecord>): string =>
    `12:00:00.000 [time]     turn ${JSON.stringify({ outcome: 'done', calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0.001, ...r })} | 1.00s`

  it('parses turn and router lines and reports p50/p95 per mode', () => {
    const log = [
      line({ mode: 'answer', totalMs: 1000, firstByteMs: 400, speechToQueryMs: 500 }),
      '12:00:00.000 [time]     router 300ms → answer 0.90, no-screen | claude-haiku-4-5 | 0.30s',
      line({ mode: 'answer', totalMs: 3000, firstByteMs: 600 }),
      line({ mode: 'locate', totalMs: 2000 }),
      line({ mode: 'action', totalMs: 9000, outcome: 'failed' }),
      '12:00:00.000 [time]     turn {torn',
      '12:00:00.000 [time]     router 500ms → locate 0.80, screen'
    ].join('\n')
    const parsed = parseLog(log)
    expect(parsed.turns).toHaveLength(4)
    expect(parsed.router).toEqual([300, 500])
    const s = summarize(parsed)
    expect(s.failed).toBe(1)
    expect(s.byMode.answer.totalMs).toEqual({ p50: 1000, p95: 3000 })
    expect(s.byMode.answer.speechToQueryMs).toEqual({ p50: 500, p95: 500 })
    expect(s.byMode.locate.firstByteMs).toEqual({ p50: null, p95: null })
    expect(s.byMode.action).toBeUndefined()
    expect(s.all.n).toBe(3)
    expect(s.router).toEqual({ n: 2, p50: 300, p95: 500 })
    const md = formatMarkdown(s)
    expect(md).toContain('| answer | 2 | 500 / 500 | 400 / 600 | 1000 / 3000 |')
    expect(md).toContain('Router: n 2, p50 300 ms, p95 500 ms')
    expect(summarize(parsed, 1).turns).toBe(1)
  })
})
