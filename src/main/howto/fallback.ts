// Locate / guide fallback (05 T36): the model's target is not on screen, so look up how to get
// there in this app, highlight the next UI name of the steps that is visible now, and show the
// steps with their source.
import type { HowtoFallback } from '../query/present'
import { groundNextName } from './ground'
import type { HowtoResult } from './types'

export type Lookup = (goal: string, signal?: AbortSignal) => Promise<HowtoResult>

/** The answer card text: where to go, step by step, with the source. */
export function fallbackText(r: HowtoResult): string {
  const steps = r.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
  const source = r.sources[0] ? `\nSource: ${r.sources[0].title} (${r.sources[0].url})` : ''
  return `It's not on screen right now. In ${r.app}:\n${steps}${source}`
}

export function makeHowtoFallback(lookup: Lookup): HowtoFallback {
  return async (prompt, ctx, signal) => {
    const r = await lookup(prompt, signal)
    if (!r.steps.length) return null
    const next = await groundNextName(r.steps, ctx)
    const step = next ? r.steps[next.step - 1] : undefined
    return {
      text: fallbackText(r),
      ...(next && step
        ? {
            item: {
              label: `Start here: ${next.name}`,
              description: step.text,
              bbox: next.resolved.logicalRect
            }
          }
        : {})
    }
  }
}
