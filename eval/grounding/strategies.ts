// Strategy adapters for the offline grounding eval. None of them call a model:
//   mock     - returns the expected answer for every other case (tests the runner and report)
//   uia-text - baseline: the query's words matched against UIA names / OCR (no model)
//   auto     - the production resolveTarget on the target the model would answer with
//              (case.modelTarget), so resolver changes are measured without API calls
import type { Rect, Target } from '@shared/types'
import { resolveTarget } from '../../src/main/query/resolve-target'
import { setScreenAdapter } from '../../src/main/actions/coords'
import {
  adapterFor,
  contextFor,
  type Case,
  type Fixture,
  type Output,
  type Strategy
} from './runner'

const NO_COST = { costUsd: 0, modelCalls: 0 }

const NONE: Output = { none: true, confidence: 0, latencyMs: 0, ...NO_COST }

function relative(r: Rect, fx: Fixture): Rect {
  return { ...r, x: r.x - fx.meta.monitor.x, y: r.y - fx.meta.monitor.y }
}

async function resolve(target: Target, fx: Fixture): Promise<Output> {
  setScreenAdapter(adapterFor(fx.meta))
  try {
    const t0 = performance.now()
    const r = await resolveTarget(target, contextFor(fx))
    const latencyMs = performance.now() - t0
    if (!r) return { ...NONE, latencyMs, debug: `${target.kind} not resolved` }
    return {
      rect: relative(r.physRect, fx),
      ...(r.elementId ? { elementId: r.elementId } : {}),
      confidence: r.confidence,
      latencyMs,
      ...NO_COST,
      debug: `${r.source}${r.notes ? ` ${r.notes.join(',')}` : ''}`
    }
  } finally {
    setScreenAdapter(null)
  }
}

export const mock: Strategy = async (c) => {
  const odd = [...c.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 2 === 1
  if ('none' in c.expected || !odd) return NONE
  return { rect: c.expected.rects[0], confidence: 0.9, latencyMs: 0, ...NO_COST }
}

export const auto: Strategy = async (c, fx) => (c.modelTarget ? resolve(c.modelTarget, fx) : NONE)

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  last: -1
}
const VERBS =
  /^(?:please\s+)?(?:click(?: on)?|press|open|select|choose|go to|turn on|turn off|find|show me|where is|where's|locate|type into)\s+/i
const ARTICLES = /^(?:the|a|an)\s+/i
const KINDS = /\s+(?:button|menu|tab|link|icon|item|page|option|toggle|field)$/i

/** The label and ordinal a query names: "click the second open link" → { text: 'open', nth: 2 }. */
export function labelOf(query: string): { text: string; nth?: number } {
  let q = query.trim().replace(VERBS, '').replace(ARTICLES, '')
  let nth: number | undefined
  const m = /^(\w+)\s+/.exec(q)
  if (m && ORDINALS[m[1].toLowerCase()] !== undefined) {
    nth = ORDINALS[m[1].toLowerCase()]
    q = q.slice(m[0].length)
  }
  q = q.replace(KINDS, '').trim()
  return nth === undefined ? { text: q } : { text: q, nth }
}

export const uiaText: Strategy = async (c: Case, fx) => {
  const { text, nth } = labelOf(c.query)
  return resolve({ kind: 'text', text, ...(nth !== undefined ? { nth } : {}) }, fx)
}

export const STRATEGIES: Record<string, Strategy> = { mock, 'uia-text': uiaText, auto }
