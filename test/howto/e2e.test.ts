// End to end with fakes (no network, no agent): an app with no pack and no accessible names →
// the agent looks up how → the looked-up UI names are grounded on screen through set-of-marks →
// the click lands on the mark → the working path is kept as an app note, so the next task in the
// same app skips the lookup.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import type { MonitorInfo, Target } from '@shared/types'
import { frameGeometryOf, setScreenAdapter } from '../../src/main/actions/coords'
import type { ToolCall, ToolTurnResult } from '../../src/main/ai/providers/types'
import {
  runAgent,
  type RunnerDeps,
  type RunResult,
  type ToolHandler
} from '../../src/main/agent-mode/runner'
import { FOREGROUND_TOOLS } from '../../src/main/agent-mode/tools'
import { HowtoCache } from '../../src/main/howto/cache'
import { makeHowtoFallback } from '../../src/main/howto/fallback'
import { groundNextName } from '../../src/main/howto/ground'
import { createLearner } from '../../src/main/howto/learn'
import { lookupHowto, type LookupDeps } from '../../src/main/howto/lookup'
import { AppNotesStore } from '../../src/main/howto/notes'
import type { PaidAnswer } from '../../src/main/howto/paid'
import { lookupHowtoHandler } from '../../src/main/howto/tool'
import type { AppIdentity } from '../../src/main/howto/types'
import type { Mark } from '../../src/main/query/marks'
import { resolveTarget, type GroundingContext } from '../../src/main/query/resolve-target'
import { display, screenAdapterFor } from '../helpers/displays'

const root = mkdtempSync(join(tmpdir(), 'lumen-howto-e2e-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => setScreenAdapter(null))

const MON: MonitorInfo = { id: 0, rect: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1, primary: true }
const APP: AppIdentity = { app: 'Krita', appId: 'krita', version: '5.2.3.0' }

/** A canvas app: no UIA names, OCR marks only ("Settings" is mark 7). */
const marks: Mark[] = [
  { n: 3, physRect: { x: 10, y: 5, w: 40, h: 20 }, source: 'ocr', label: 'File' },
  { n: 7, physRect: { x: 400, y: 5, w: 80, h: 20 }, source: 'ocr', label: 'Settings' },
  { n: 9, physRect: { x: 500, y: 5, w: 60, h: 20 }, source: 'ocr', label: 'Help' }
]
const ctx: GroundingContext = {
  frames: [
    {
      label: '1',
      monitor: MON,
      geometry: frameGeometryOf({ width: 1920, height: 1080, monitor: MON })
    }
  ],
  marks
}

let seq = 0
const call = (name: string, input: Record<string, unknown>): ToolCall => ({
  id: `c${++seq}`,
  name,
  input
})
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
const reply = (...calls: ToolCall[]): ToolTurnResult => ({
  message: { role: 'assistant', text: '', calls },
  usage,
  model: 'fake',
  stopReason: 'tool_use'
})

interface Setup {
  store: AppNotesStore
  paid: Mock<() => Promise<PaidAnswer>>
  lookupDeps: LookupDeps
}

function setup(): Setup {
  const store = new AppNotesStore(join(root, `s${++seq}`))
  const paid = vi.fn(
    async (): Promise<PaidAnswer> => ({
      steps: [
        { text: 'Open Settings > Configure Krita', ui: ['Settings', 'Configure Krita'] },
        { text: 'Pick Display and set the scale', ui: ['Display'] }
      ],
      sources: [
        {
          title: 'Krita Manual',
          url: 'https://docs.krita.org/en/reference_manual/preferences.html'
        }
      ],
      searches: 1,
      model: 'claude-haiku-4-5'
    })
  )
  const lookupDeps: LookupDeps = {
    mode: () => 'auto',
    paidAllowed: () => true,
    notes: () => store,
    cache: new HowtoCache(null),
    get: async (url) => ({ url, status: 404, body: '' }),
    paid,
    recordPaid: (a) => a.searches * 0.01,
    log: () => {}
  }
  return { store, paid, lookupDeps }
}

async function runTask(
  s: Setup,
  script: ToolTurnResult[]
): Promise<{ r: RunResult; clicks: { target: Target; x: number; y: number }[]; looked: string[] }> {
  const learner = createLearner({ notes: () => s.store, identify: async () => APP })
  const clicks: { target: Target; x: number; y: number }[] = []
  const looked: string[] = []
  const act: ToolHandler = async (input, c) => {
    const t = input.target as { kind: 'mark' | 'text'; ref: string }
    const target: Target =
      t.kind === 'mark' ? { kind: 'mark', n: Number(t.ref) } : { kind: 'text', text: t.ref }
    const r = await resolveTarget(target, ctx)
    if (!r) {
      await learner.failed(t.ref)
      return { content: [{ type: 'text', text: 'not found' }], isError: true }
    }
    clicks.push({ target, x: r.physRect.x + r.physRect.w / 2, y: r.physRect.y + r.physRect.h / 2 })
    const name = t.kind === 'mark' ? marks.find((m) => m.n === Number(t.ref))?.label : t.ref
    await learner.acted(
      c.task().steps.find((s) => s.i === c.step)?.label ?? c.task().prompt,
      'click',
      { name }
    )
    return { content: [{ type: 'text', text: 'clicked' }], actions: 1 }
  }
  let i = 0
  const deps: RunnerDeps = {
    model: {
      plan: async () => ({
        plan: { summary: 'make the UI bigger', steps: ['Make the UI bigger'], risk: 'low' }
      }),
      turn: async () => script[Math.min(i++, script.length - 1)]
    },
    handlers: {
      act,
      observe: async () => ({
        content: [{ type: 'text', text: 'marks: 3 File, 7 Settings, 9 Help' }]
      }),
      lookup_howto: lookupHowtoHandler({
        identify: async () => APP,
        lookup: async (id, goal, taskId, signal) => {
          const r = await lookupHowto({ id, goal, taskId }, s.lookupDeps, signal)
          looked.push(r.from)
          return r
        },
        onResult: (id, r) => learner.looked(id, r)
      })
    },
    publish: () => {},
    speak: () => {},
    countdown: async () => 'go',
    askContinue: async () => false,
    costOf: () => 0,
    now: () => Date.now()
  }
  const r = await runAgent(
    {
      prompt: 'make the UI bigger in Krita',
      context: {},
      tools: FOREGROUND_TOOLS,
      cancelWindowMs: 0
    },
    deps
  )
  return { r, clicks, looked }
}

describe('unknown app → lookup → marks → click', () => {
  it('grounds the looked-up names on marks and clicks there; the next task uses the note', async () => {
    setScreenAdapter(
      screenAdapterFor({
        name: 'fhd',
        displays: [display('m', { x: 0, y: 0, width: 1920, height: 1080 }, 1, { x: 0, y: 0 }, true)]
      })
    )
    const s = setup()

    // The grounding step on its own: "Settings" from the docs is mark 7 on this screen.
    const steps = (
      await lookupHowto({ id: APP, goal: 'make the UI bigger', taskId: 'probe' }, s.lookupDeps)
    ).steps
    const next = await groundNextName(steps, ctx)
    expect(next).toMatchObject({ name: 'Settings', step: 1, target: { kind: 'mark', n: 7 } })
    expect(next?.resolved.physRect).toEqual(marks[1].physRect)

    // The agent loop: lookup, observe, click mark 7, finish.
    const first = await runTask(s, [
      reply(call('lookup_howto', { goal: 'make the UI bigger', app: '' })),
      reply(call('observe', { what: 'screen' })),
      reply(call('act', { op: 'click', target: { kind: 'mark', ref: '7' }, step: 1 })),
      reply(call('finish', { summary: 'Opened the settings.' }))
    ])
    expect(first.r.status).toBe('done')
    expect(first.looked).toEqual(['cache'])
    expect(first.clicks).toEqual([{ target: { kind: 'mark', n: 7 }, x: 440, y: 15 }])
    expect(first.r.task.counters.costUsd).toBe(0)
    expect(s.paid).toHaveBeenCalledTimes(1)
    expect(s.store.find(APP, 'make the UI bigger')?.path.ui).toEqual(['Settings'])

    // Next time: the app note answers first, no lookup at all.
    const second = await runTask(s, [
      reply(call('lookup_howto', { goal: 'Make the UI bigger', app: '' })),
      reply(call('act', { op: 'click', target: { kind: 'text', ref: 'Settings' }, step: 1 })),
      reply(call('finish', { summary: 'Done.' }))
    ])
    expect(second.looked).toEqual(['notes'])
    expect(s.paid).toHaveBeenCalledTimes(1)
  })

  it('a locate the model could not ground falls back to the lookup and highlights the next name', async () => {
    setScreenAdapter(
      screenAdapterFor({
        name: 'fhd',
        displays: [display('m', { x: 0, y: 0, width: 1920, height: 1080 }, 1, { x: 0, y: 0 }, true)]
      })
    )
    const s = setup()
    const fallback = makeHowtoFallback((goal, signal) =>
      lookupHowto({ id: APP, goal, taskId: 'turn-1' }, s.lookupDeps, signal)
    )
    const r = await fallback('where do I make the UI bigger', ctx)
    expect(r?.text).toContain("It's not on screen right now. In Krita:")
    expect(r?.text).toContain('Source: Krita Manual')
    expect(r?.item).toMatchObject({
      label: 'Start here: Settings',
      bbox: { x: 400, y: 5, w: 80, h: 20 }
    })
  })
})
