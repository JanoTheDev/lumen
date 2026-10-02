import { describe, it, expect } from 'vitest'
import type { UsageRow } from '../../src/main/usage/ledger'
import type { LimitState } from '../../src/main/usage/limits'
import {
  answerUsageQuestion,
  matchNamed,
  parseUsageQuestion,
  rangeOf,
  usageTurn,
  type AnswerSources,
  type NamedScope
} from '../../src/main/usage/voice'

const NOW = new Date(2026, 9, 8, 15) // Thursday 8 Oct 2026

const row = (o: Partial<UsageRow>): UsageRow => ({
  t: NOW.getTime() - 60_000,
  provider: 'anthropic',
  model: 'm',
  in: 1000,
  out: 500,
  cacheRead: 0,
  cacheWrite: 0,
  searches: 0,
  audioSec: 0,
  usd: 0.1,
  priced: true,
  free: false,
  origin: 'user-direct',
  feature: 'answer',
  ...o
})

const SCOPES: NamedScope[] = [
  { kind: 'automation', id: 'au_morning', name: 'Morning brief' },
  { kind: 'automation', id: 'au_evening', name: 'Evening summary' },
  { kind: 'buddy', id: 'inbox-buddy', name: 'Inbox Buddy' }
]

function sources(rows: UsageRow[], limit: LimitState | null = null): AnswerSources {
  return {
    rows: (from, to) => rows.filter((r) => r.t >= from && r.t < to),
    scopes: () => SCOPES,
    limit: () => limit,
    now: () => NOW
  }
}

describe('parseUsageQuestion', () => {
  it.each([
    ['How much did I spend this week?', { kind: 'spend', when: 'week' }],
    ['how much have I spent today', { kind: 'spend', when: 'today' }],
    ['How much did I spend on AI this month', { kind: 'spend', when: 'month' }],
    ['what did I spend yesterday', { kind: 'spend', when: 'yesterday' }],
    ['how much does Lumen cost me', { kind: 'spend', when: 'month' }],
    ['how many tokens did I use today', { kind: 'spend', when: 'today' }],
    ['What used the most tokens today?', { kind: 'top', when: 'today', by: 'tokens' }],
    ['what cost the most this month', { kind: 'top', when: 'month', by: 'cost' }],
    [
      'How much does my morning automation cost?',
      { kind: 'named', name: 'morning', when: 'month', hint: 'automation' }
    ],
    [
      'how much has Inbox Buddy cost',
      { kind: 'named', name: 'inbox buddy', when: 'month', hint: 'buddy' }
    ],
    [
      'what did the evening summary cost last month',
      { kind: 'named', name: 'evening summary', when: 'last-month' }
    ]
  ])('%s', (text, want) => {
    expect(parseUsageQuestion(text)).toEqual(want)
  })

  it.each([
    'how much did I spend on groceries this month',
    'how much does a flight to Paris cost tomorrow',
    'how much does it cost',
    'what is the weather today',
    'Inbox Buddy, what is new?'
  ])('not a usage question: %s', (text) => {
    const q = parseUsageQuestion(text)
    if (q?.kind === 'named') expect(matchNamed(q, SCOPES)).toBeNull()
    else expect(q).toBeNull()
  })
})

describe('matchNamed', () => {
  it('matches spoken words inside a name', () => {
    expect(matchNamed({ name: 'morning', hint: 'automation' }, SCOPES)?.id).toBe('au_morning')
    expect(matchNamed({ name: 'inbox buddy' }, SCOPES)?.id).toBe('inbox-buddy')
    expect(matchNamed({ name: 'inbox', hint: 'buddy' }, SCOPES)?.id).toBe('inbox-buddy')
    expect(matchNamed({ name: 'night' }, SCOPES)).toBeNull()
  })
})

describe('rangeOf', () => {
  it('starts the week on Monday and the month on the 1st', () => {
    expect(new Date(rangeOf('week', NOW).from)).toEqual(new Date(2026, 9, 5))
    expect(new Date(rangeOf('month', NOW).from)).toEqual(new Date(2026, 9, 1))
    expect(rangeOf('last-month', NOW)).toEqual({
      from: new Date(2026, 8, 1).getTime(),
      to: new Date(2026, 9, 1).getTime()
    })
  })
})

describe('answerUsageQuestion', () => {
  it('sums spend for the period, with the overall cap', () => {
    const rows = [row({}), row({ usd: 0.15 }), row({ t: new Date(2026, 8, 20).getTime(), usd: 9 })]
    const limit: LimitState = {
      scope: { kind: 'overall' },
      usd: 0.25,
      tokens: 3000,
      cap: { usd: 1 },
      ratio: 0.25,
      level: 'ok'
    }
    expect(answerUsageQuestion({ kind: 'spend', when: 'week' }, sources(rows, limit))).toBe(
      "You spent about $0.25 this week, 3k tokens over 2 calls. That's 25% of your monthly limit of $1.00."
    )
  })

  it('says free usage in tokens', () => {
    const rows = [row({ usd: 0, free: true })]
    expect(answerUsageQuestion({ kind: 'spend', when: 'today' }, sources(rows))).toBe(
      'Today Lumen used 2k tokens over 1 call, all free.'
    )
  })

  it('names the top features and the biggest automation', () => {
    const rows = [
      row({ feature: 'agent-step', in: 50_000, usd: 0.5, automationId: 'au_morning' }),
      row({ feature: 'answer', in: 10_000, usd: 0.05 }),
      row({ feature: 'router', in: 2000, usd: 0.01 })
    ]
    const text = answerUsageQuestion({ kind: 'top', when: 'today', by: 'tokens' }, sources(rows))
    expect(text).toBe(
      'Most tokens today: agent tasks, $0.50 (51k tokens). Then answers, $0.05 (11k tokens); understanding requests, $0.01 (3k tokens). The biggest automation was Morning brief, $0.50 (51k tokens).'
    )
  })

  it('answers for one automation or buddy', () => {
    const rows = [
      row({ automationId: 'au_morning', taskId: 't1', usd: 0.2 }),
      row({ automationId: 'au_morning', taskId: 't2', usd: 0.4 }),
      row({ buddyId: 'inbox-buddy', usd: 0.3 })
    ]
    expect(
      answerUsageQuestion(
        { kind: 'named', name: 'morning', when: 'month', hint: 'automation' },
        sources(rows)
      )
    ).toBe(
      'Your Morning brief automation cost $0.60 this month, 3k tokens. About $0.30 a run over 2 runs.'
    )
    expect(
      answerUsageQuestion({ kind: 'named', name: 'inbox buddy', when: 'month' }, sources(rows))
    ).toBe('Inbox Buddy cost $0.30 this month, 2k tokens.')
    expect(
      answerUsageQuestion({ kind: 'named', name: 'evening summary', when: 'month' }, sources(rows))
    ).toBe("Your Evening summary automation hasn't used anything this month.")
  })

  it('usageTurn gives an answer card or falls through', () => {
    const src = sources([row({})])
    expect(usageTurn('how much did I spend today', src)).toMatchObject({
      mode: 'answer',
      text: expect.stringMatching(/^You spent about \$0\.10 today/)
    })
    expect(usageTurn('how much does a tesla cost', src)).toBeNull()
    expect(usageTurn('open notepad', src)).toBeNull()
  })
})

describe('named questions only for a name said whole or with its kind (review M4)', () => {
  const scopes: NamedScope[] = [
    { kind: 'automation', id: 'a1', name: 'Netflix renewal reminder' },
    { kind: 'buddy', id: 'b1', name: 'Flight Price Buddy' }
  ]
  const src: AnswerSources = {
    rows: () => [row({ automationId: 'a1', usd: 0.5 }), row({ buddyId: 'b1', usd: 0.2 })],
    scopes: () => scopes,
    limit: () => null,
    now: () => NOW
  }

  it.each([
    'how much does Netflix cost',
    'how much does flight cost',
    'how much does a flight cost'
  ])('%s is a shopping question', (text) => expect(usageTurn(text, src)).toBeNull())

  it.each([
    ['how much does my Netflix reminder automation cost', /Netflix renewal reminder automation/],
    ['how much has Flight Price Buddy cost', /Flight Price Buddy cost/],
    ['how much does flight price cost', /Flight Price Buddy cost/],
    ['how much has my price buddy cost', /Flight Price Buddy cost/]
  ])('%s still answers', (text, want) => {
    expect(usageTurn(text, src)?.text).toMatch(want)
  })

  it('leaves price questions to fresh answer cards unless spend words are said', () => {
    const cards = (): boolean => true
    expect(usageTurn('how much does Flight Price Buddy cost', src, cards)).toBeNull()
    expect(usageTurn('what cost the most today', src, cards)).toBeNull()
    expect(usageTurn('how much has Flight Price Buddy used', src, cards)?.text).toMatch(/Flight/)
    expect(usageTurn('how much did I spend this month', src, cards)?.text).toMatch(/spent/)
  })
})
