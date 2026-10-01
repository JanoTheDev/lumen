import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ nativeImage: {} }))

import type { Action, ModelResponse } from '@shared/types'
import { runLoop, type Decision, type LoopDeps, type LoopOptions } from '../../src/main/ai/loop'
import type { Observed } from '../../src/main/ai/observe'
import type { Verdict } from '../../src/main/ai/verify'
import type { ExecuteResult } from '../../src/main/actions/executor'
import type { QueryContext } from '../../src/main/query/context'
import { CancelledError } from '../../src/main/query/cancel'

let shot = 0
function observed(): Observed {
  const n = ++shot
  const ctx = {
    frames: [],
    foreground: { title: 'App' },
    ocr: async () => null,
    activeWindow: 'App',
    screenshot: `img${n}`,
    at: n
  } as QueryContext
  return { ctx, obs: { at: n, title: 'App', image: `img${n}` } }
}

const act = (over: Partial<ExecuteResult> = {}): ExecuteResult => ({
  executed: 1,
  cancelled: false,
  blocked: false,
  reachedBottom: false,
  targets: [],
  ...over
})
const reply = (actions: Action[]): ModelResponse => ({ mode: 'action', actions })
const ok: Verdict = { ok: true, confidence: 0.9, reason: 'ok', evidence: 'uia' }
const bad: Verdict = { ok: false, confidence: 0.85, reason: 'nothing changed', evidence: 'diff' }

interface Harness {
  deps: LoopDeps
  acted: Action[][]
  refined: boolean[]
  observes: number
}

function harness(
  decide: LoopDeps['decide'],
  verdicts: Verdict[] = [],
  over: Partial<LoopDeps> = {}
): Harness {
  const h: Harness = { acted: [], refined: [], observes: 0, deps: {} as LoopDeps }
  h.deps = {
    observe: async () => {
      h.observes++
      return observed()
    },
    decide,
    act: async (actions, o) => {
      h.acted.push(actions)
      h.refined.push(o.forceRefine)
      return act()
    },
    settle: async () => undefined,
    verify: async () => verdicts.shift() ?? ok,
    ...over
  }
  return h
}

const options = (over: Partial<LoopOptions> = {}): LoopOptions => ({
  goal: 'draft an email',
  steps: [{ intent: 'Click Compose' }, { intent: 'Fill Subject "Hi"' }],
  maxSteps: 8,
  verify: true,
  signal: new AbortController().signal,
  ...over
})

describe('runLoop (T19)', () => {
  it('runs every step: observe once per step, the after shot is the next before', async () => {
    const seen: string[] = []
    const h = harness(async (s) => {
      seen.push(`${s.index}:${s.ctx.screenshot}:${s.history.length}`)
      return {
        response: reply([{ type: 'click', x: 1, y: 1 }]),
        actions: [{ type: 'click', x: 1, y: 1 }]
      }
    })
    const start = observed()
    const r = await runLoop(options({ start }), h.deps)
    expect(r.status).toBe('done')
    expect(r.history.map((x) => x.ok)).toEqual([true, true])
    expect(h.acted).toHaveLength(2)
    // Step 1 decides on the start shot, step 2 on step 1's after shot: 2 captures total.
    expect(h.observes).toBe(2)
    expect(seen[0]).toBe(`1:${start.ctx.screenshot}:0`)
    expect(seen[1]).toMatch(/^2:img\d+:1$/)
  })

  it('retries without retyping text that is already in the field, refining the target', async () => {
    const step: Action[] = [
      { type: 'click_target', target: { kind: 'text', text: 'Subject' } },
      { type: 'type', text: 'Resignation' }
    ]
    const decisions: number[] = []
    const alreadyTyped = vi.fn(async () => true)
    const h = harness(
      async (s) => {
        decisions.push(s.attempt)
        if (s.attempt) expect(s.lastFailure).toBe('nothing changed')
        return { response: reply(step), actions: step }
      },
      [bad, ok],
      { alreadyTyped }
    )
    const r = await runLoop(options({ steps: [{ intent: 'Fill Subject' }] }), h.deps)
    expect(r.status).toBe('done')
    expect(decisions).toEqual([0, 1])
    expect(h.acted[0].map((a) => a.type)).toEqual(['click_target', 'type'])
    expect(h.acted[1].map((a) => a.type)).toEqual(['click_target'])
    expect(alreadyTyped).toHaveBeenCalledWith('Resignation', expect.anything(), expect.anything())
    expect(h.refined).toEqual([false, true])
  })

  it('retypes when the text is not there yet', async () => {
    const step: Action[] = [{ type: 'type', text: 'Hello' }]
    const h = harness(async () => ({ response: reply(step), actions: step }), [bad, ok], {
      alreadyTyped: async () => false
    })
    await runLoop(options({ steps: [{ intent: 'type' }] }), h.deps)
    expect(h.acted).toEqual([step, step])
  })

  it('a retry whose typing is all on screen already completes the step without acting', async () => {
    const step: Action[] = [{ type: 'type', text: 'Hello' }]
    const h = harness(async () => ({ response: reply(step), actions: step }), [bad], {
      alreadyTyped: async () => true
    })
    const r = await runLoop(options({ steps: [{ intent: 'type' }] }), h.deps)
    expect(r.status).toBe('done')
    expect(h.acted).toHaveLength(1)
    expect(r.history[0]).toMatchObject({ ok: true, note: 'already typed' })
  })

  it('gives up after maxRetries and replans the rest', async () => {
    const intents: string[] = []
    const replan = vi.fn(async () => [{ intent: 'Press C' }])
    const h = harness(
      async (s) => {
        intents.push(s.step.intent)
        return {
          response: reply([{ type: 'click', x: 1, y: 1 }]),
          actions: [{ type: 'click', x: 1, y: 1 }]
        }
      },
      [bad, bad, bad, ok],
      { replan }
    )
    const r = await runLoop(
      options({ steps: [{ intent: 'Click Compose' }, { intent: 'Fill' }] }),
      h.deps
    )
    expect(intents).toEqual(['Click Compose', 'Click Compose', 'Click Compose', 'Press C'])
    expect(replan).toHaveBeenCalledOnce()
    expect(r.status).toBe('done')
    expect(r.history.map((x) => x.ok)).toEqual([false, true])
  })

  it('fails when the step keeps failing and nothing replans', async () => {
    const h = harness(
      async () => ({
        response: reply([{ type: 'click', x: 1, y: 1 }]),
        actions: [{ type: 'click', x: 1, y: 1 }]
      }),
      [bad, bad, bad]
    )
    const r = await runLoop(options(), h.deps)
    expect(r.status).toBe('failed')
    expect(h.acted).toHaveLength(3)
  })

  it('stops at maxSteps', async () => {
    const h = harness(async () => ({
      response: reply([{ type: 'scroll', direction: 'down', amount: 1 }]),
      actions: [{ type: 'scroll', direction: 'down', amount: 1 }],
      next: { intent: 'keep looking' }
    }))
    const r = await runLoop(
      options({ steps: [{ intent: 'research' }], maxSteps: 3, verify: false }),
      h.deps
    )
    expect(r.status).toBe('max-steps')
    expect(h.acted).toHaveLength(3)
  })

  it('ends with the final reply when a step has no actions (research answer)', async () => {
    const answer: ModelResponse = { mode: 'answer', text: 'Found it' }
    let n = 0
    const h = harness(
      async (): Promise<Decision> =>
        ++n < 2
          ? {
              response: reply([{ type: 'click', x: 1, y: 1 }]),
              actions: [{ type: 'click', x: 1, y: 1 }],
              next: { intent: 'again' }
            }
          : { response: answer, actions: [], done: true }
    )
    const r = await runLoop(options({ steps: [{ intent: 'research' }], verify: false }), h.deps)
    expect(r).toMatchObject({ status: 'done', final: answer })
  })

  it('a declined risky step runs nothing', async () => {
    const confirm = vi.fn(async () => false)
    const h = harness(
      async () => ({
        response: reply([{ type: 'click', x: 1, y: 1 }]),
        actions: [{ type: 'click', x: 1, y: 1 }]
      }),
      [],
      {
        confirm
      }
    )
    const r = await runLoop(options({ steps: [{ intent: 'Click Send', risky: true }] }), h.deps)
    expect(r.status).toBe('denied')
    expect(confirm).toHaveBeenCalledOnce()
    expect(h.acted).toHaveLength(0)
  })

  it('a risky reply from the model also asks first', async () => {
    const confirm = vi.fn(async () => true)
    const h = harness(
      async () => ({
        response: reply([{ type: 'click', x: 1, y: 1 }]),
        actions: [{ type: 'click', x: 1, y: 1 }],
        risky: true
      }),
      [],
      { confirm }
    )
    await runLoop(options({ steps: [{ intent: 'Click' }] }), h.deps)
    expect(confirm).toHaveBeenCalledOnce()
    expect(h.acted).toHaveLength(1)
  })

  describe('abort', () => {
    it('during decide: nothing runs', async () => {
      const ac = new AbortController()
      const h = harness(async () => {
        ac.abort(new CancelledError())
        return {
          response: reply([{ type: 'click', x: 1, y: 1 }]),
          actions: [{ type: 'click', x: 1, y: 1 }]
        }
      })
      await expect(runLoop(options({ signal: ac.signal }), h.deps)).rejects.toBeInstanceOf(
        CancelledError
      )
      expect(h.acted).toHaveLength(0)
    })

    it('during act: no verify, no next step', async () => {
      const ac = new AbortController()
      const verify = vi.fn(async () => ok)
      const h = harness(
        async () => ({
          response: reply([{ type: 'click', x: 1, y: 1 }]),
          actions: [{ type: 'click', x: 1, y: 1 }]
        }),
        [],
        {
          verify,
          act: async () => {
            ac.abort(new CancelledError())
            return act({ cancelled: true })
          }
        }
      )
      await expect(runLoop(options({ signal: ac.signal }), h.deps)).rejects.toBeInstanceOf(
        CancelledError
      )
      expect(verify).not.toHaveBeenCalled()
    })

    it('during verify: no retry, no next step', async () => {
      const ac = new AbortController()
      const h = harness(
        async () => ({
          response: reply([{ type: 'click', x: 1, y: 1 }]),
          actions: [{ type: 'click', x: 1, y: 1 }]
        }),
        [],
        {
          verify: async () => {
            ac.abort(new CancelledError())
            return bad
          }
        }
      )
      await expect(runLoop(options({ signal: ac.signal }), h.deps)).rejects.toBeInstanceOf(
        CancelledError
      )
      expect(h.acted).toHaveLength(1)
    })

    it('during the confirm window: the risky step never runs', async () => {
      const ac = new AbortController()
      const h = harness(
        async () => ({
          response: reply([{ type: 'click', x: 1, y: 1 }]),
          actions: [{ type: 'click', x: 1, y: 1 }]
        }),
        [],
        {
          confirm: async () => {
            ac.abort(new CancelledError())
            return true
          }
        }
      )
      await expect(
        runLoop(options({ steps: [{ intent: 'Send', risky: true }], signal: ac.signal }), h.deps)
      ).rejects.toBeInstanceOf(CancelledError)
      expect(h.acted).toHaveLength(0)
    })
  })
})
