import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildPlan,
  normalizePlan,
  planSchema,
  replan,
  stepPrompt,
  MAX_PLAN_STEPS,
  type Plan
} from '../../src/main/ai/planner'
import { setProvider } from '../../src/main/ai/providers'
import {
  EMPTY_USAGE,
  type CompleteResult,
  type LlmProvider,
  type StructuredRequest
} from '../../src/main/ai/providers/types'
import { anthropicJsonSchema } from '../../src/main/ai/providers/structured'
import { setConfigDir } from '../../src/main/config'
import { tempDir } from '../helpers/fixtures'

const requests: StructuredRequest<unknown>[] = []
let reply: (req: StructuredRequest<unknown>) => unknown = () => null

function fakeProvider(): LlmProvider {
  return {
    id: 'anthropic',
    async *stream() {
      yield* []
    },
    async complete<T>(req: StructuredRequest<T>, signal?: AbortSignal) {
      requests.push(req as StructuredRequest<unknown>)
      signal?.throwIfAborted()
      const out = reply(req as StructuredRequest<unknown>)
      if (out instanceof Error) throw out
      return {
        text: JSON.stringify(out),
        data: null,
        usage: EMPTY_USAGE,
        model: req.model,
        stopReason: 'end_turn'
      } as CompleteResult<T>
    },
    async warmup() {
      return
    }
  }
}

const COMPOSE: Plan = {
  goal: 'Draft a resignation email',
  steps: [
    {
      intent: 'Navigate to https://mail.google.com',
      successCriteria: 'Inbox visible',
      risky: false
    },
    { intent: 'Click Compose', successCriteria: 'A new message window is open', risky: false },
    { intent: 'Fill Subject "Resignation"', successCriteria: 'Subject filled', risky: false }
  ]
}

describe('planner (T18)', () => {
  const key = process.env.ANTHROPIC_API_KEY
  let t: ReturnType<typeof tempDir>
  beforeEach(() => {
    t = tempDir()
    setConfigDir(t.dir)
    process.env.ANTHROPIC_API_KEY = 'test-key'
    setProvider('anthropic', fakeProvider())
    requests.length = 0
  })
  afterEach(() => {
    setProvider('anthropic', null)
    process.env.ANTHROPIC_API_KEY = key
    setConfigDir(null)
    t.cleanup()
  })

  it('asks the planning role for the plan schema and returns intents', async () => {
    reply = () => COMPOSE
    const plan = await buildPlan('email my boss I quit', { activeWindow: 'Chrome' })
    expect(plan).toEqual(COMPOSE)
    expect(requests[0].schema).toBe(planSchema)
    expect(requests[0].messages[0].content).toContain('<goal>email my boss I quit</goal>')
    // The JSON schema sent to the provider is strict and has the three step fields.
    const json = JSON.stringify(anthropicJsonSchema(planSchema))
    for (const f of ['intent', 'successCriteria', 'risky']) expect(json).toContain(f)
    expect(json).toContain('"additionalProperties":false')
  })

  it('caps steps and flags sending as risky even when the model did not', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      intent: i === 0 ? 'Click Send' : `Step ${i}`,
      successCriteria: '',
      risky: false
    }))
    const plan = normalizePlan({ goal: 'g', steps: many }, 'g')
    expect(plan.steps).toHaveLength(MAX_PLAN_STEPS)
    expect(plan.steps[0].risky).toBe(true)
    expect(plan.steps[1].risky).toBe(false)
  })

  it('falls back to the goal as one step when the planner fails', async () => {
    reply = () => new Error('overloaded')
    const plan = await buildPlan('open the weather site', { activeWindow: 'Chrome' })
    expect(plan.steps).toEqual([
      { intent: 'open the weather site', successCriteria: '', risky: false }
    ])
  })

  it('propagates cancellation instead of falling back', async () => {
    reply = () => COMPOSE
    const ac = new AbortController()
    ac.abort()
    await expect(buildPlan('x', { activeWindow: 'w' }, ac.signal)).rejects.toThrow()
  })

  it('replans the remaining steps after a failed one, with the history in the prompt', async () => {
    reply = () => ({
      goal: 'ignored',
      steps: [{ intent: 'Press C to compose', successCriteria: 'Compose open', risky: false }]
    })
    const next = await replan(
      COMPOSE,
      [{ intent: COMPOSE.steps[0].intent, ok: true }],
      { step: COMPOSE.steps[1], reason: 'Compose button not found' },
      { activeWindow: 'Inbox - Gmail' }
    )
    expect(next?.goal).toBe(COMPOSE.goal)
    expect(next?.steps.map((s) => s.intent)).toEqual(['Press C to compose'])
    const sent = requests[0].messages[0].content
    expect(sent).toContain('1. Navigate to https://mail.google.com - done')
    expect(sent).toContain('<failed>Click Compose - Compose button not found</failed>')
  })

  it('replan returns null when there is no other way', async () => {
    reply = () => ({ goal: 'g', steps: [] })
    const next = await replan(
      COMPOSE,
      [],
      { step: COMPOSE.steps[0], reason: 'x' },
      { activeWindow: 'w' }
    )
    expect(next).toBeNull()
  })

  it('every step prompt carries the original goal and the step history', () => {
    const p = stepPrompt(COMPOSE.goal, COMPOSE.steps[2], 3, 3, [
      { intent: 'Navigate to https://mail.google.com', ok: true },
      { intent: 'Click Compose', ok: true }
    ])
    expect(p).toContain('<goal>Draft a resignation email</goal>')
    expect(p).toContain('<step n="3" of="3">Fill Subject "Resignation"</step>')
    expect(p).toContain('<success>Subject filled</success>')
    expect(p).toContain('2. Click Compose - done')
  })
})
