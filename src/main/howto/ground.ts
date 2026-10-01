// Looked-up UI names → screen targets (05 T36). A name from a how-to step is tried as visible
// text (UIA name first, then OCR, via resolveTarget) and against this turn's set-of-marks
// labels, so "Format" in the docs becomes the Format menu on screen, or mark 7 in an app without
// accessible names. Menu paths are grounded one segment at a time: the first visible one is the
// next click.
import type { Target } from '@shared/types'
import type { Mark } from '../query/marks'
import { resolveFirst, type GroundingContext, type ResolvedTarget } from '../query/resolve-target'
import { normLabel } from './learn'
import type { HowtoStep } from './types'

/** Marks whose label is the name (exact first, then a label that starts with it). */
export function marksNamed(marks: Mark[] | undefined, name: string): Mark[] {
  const want = normLabel(name)
  if (!want || !marks?.length) return []
  const exact = marks.filter((m) => normLabel(m.label) === want)
  if (exact.length) return exact
  return marks.filter((m) => {
    const l = normLabel(m.label)
    return l.startsWith(`${want} `) || l === `${want} ...`
  })
}

/** Targets to try for one UI name, best first. */
export function targetsFor(name: string, ctx: Pick<GroundingContext, 'marks'>): Target[] {
  const text = name.replace(/[.…]+$/, '').trim()
  const out: Target[] = []
  if (text) out.push({ kind: 'text', text })
  for (const m of marksNamed(ctx.marks, name)) out.push({ kind: 'mark', n: m.n })
  return out
}

export interface GroundedName {
  name: string
  step: number
  target: Target
  resolved: ResolvedTarget
}

/** The first UI name of the steps that is on screen now (the next thing to click), or null. */
export async function groundNextName(
  steps: HowtoStep[],
  ctx: GroundingContext
): Promise<GroundedName | null> {
  for (let i = 0; i < steps.length; i++) {
    for (const name of steps[i].ui) {
      const targets = targetsFor(name, ctx)
      const resolved = await resolveFirst(targets, ctx)
      if (!resolved) continue
      const target =
        resolved.source === 'mark'
          ? (targets.find((t) => t.kind === 'mark') as Target)
          : (targets[0] as Target)
      return { name, step: i + 1, target, resolved }
    }
  }
  return null
}
