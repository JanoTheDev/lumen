// Record my steps (07 T31): the fast model turns the recorded steps into lesson lines. It only
// writes words: which recorded steps to keep, a spoken `say` per step, a short why and one
// hint. Targets and checks come from the recording itself (recorder.ts), never from the model.
import { z } from 'zod'
import { describeStep, type RecordedApp, type SkeletonStep } from './recorder'

// Every field required (strict structured output on both providers).
export const draftTextSchema = z.object({
  title: z.string(),
  steps: z.array(
    z.object({
      from: z.number(),
      say: z.string(),
      why: z.string(),
      hint: z.string()
    })
  )
})

export const RECORD_PROMPT = `You turn a recording of someone doing a task on Windows into a short spoken lesson that teaches another person (often a beginner, often using a screen reader) to do the same task.

You get the app, an optional title the person said, and the recorded steps in order: clicks, selections, fields they typed into (the text itself is never recorded), shortcuts, and windows that opened. Some steps may have a screenshot attached.

Return JSON:
- title: a short task name, 3 to 8 words, sentence case, no trailing period (keep the person's title when it fits).
- steps: the steps worth teaching, in the recorded order. For each:
  - from: the recorded step number it comes from (each number at most once, increasing).
  - say: one instruction for the ear, at most 25 words. Name the control and where it is when that helps ("In the left list, select Personalization."). Spell shortcuts out ("Press Control S"). No "just", "simply", "easy", no exclamation marks, no markdown, no coordinates.
  - why: one short sentence on why this step matters, or "".
  - hint: one extra tip for someone stuck (where to look, another way), or "". Never repeat the say line.

Rules:
- Leave out steps that look accidental or are only focus passing through, unless the task needs them.
- For a field the person typed into, say what to type in general terms ("Type the name you want"); never invent the text.
- Do not add steps that were not recorded.`

export interface RecordTurnInput {
  app: RecordedApp
  title?: string
  steps: SkeletonStep[]
  /** Screenshots attached to the request, in order. */
  shots: number
}

export function recordTurn(input: RecordTurnInput): string {
  const lines = [
    `App: ${input.app.name}${input.app.process ? ` (${input.app.process})` : ''}`,
    input.title ? `Title the person said: ${input.title}` : 'Title: none given',
    '',
    'Recorded steps:',
    ...input.steps.map(describeStep)
  ]
  if (input.shots)
    lines.push('', `${input.shots} screenshot(s) attached, numbered as in the steps above.`)
  return lines.join('\n')
}
