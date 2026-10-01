// The UI calls of one agent run, for "save that as a skill" (11 T09). Element ids only mean
// something inside the run, so an act on an element is kept as the element's name, role and
// automation id from the snapshot the model saw. Memory only: the trace is never written to
// disk (typed values are in it).
import type { ElementNode } from '@shared/types'
import { currentContext } from '../query/context'
import { elementIndex } from '../query/uia-list'
import type { TraceStep } from '../skills/authoring'

export const MAX_TRACE_STEPS = 60

export interface RunTrace {
  readonly steps: TraceStep[]
  /** The step a call would add (null: not a UI call); `after` keeps it once the call worked. */
  before(tool: string, input: Record<string, unknown>): TraceStep | null
  after(step: TraceStep): void
}

type Lookup = (id: string) => ElementNode | undefined

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** One tool call as a trace step; null for calls that do not touch the UI. */
export function traceStep(
  tool: string,
  input: Record<string, unknown>,
  element: Lookup
): TraceStep | null {
  switch (tool) {
    case 'act': {
      const t = input.target as { kind?: string; ref?: string } | undefined
      const step: TraceStep = { tool: 'act', op: str(input.op) ?? 'click' }
      const value = str(input.value)
      if (value !== undefined) step.value = value
      if (t?.kind === 'element' && t.ref) {
        const el = element(t.ref)
        if (el && (el.name || el.automationId))
          step.element = {
            ...(el.name ? { name: el.name.slice(0, 200) } : {}),
            ...(el.role ? { role: el.role.slice(0, 40) } : {}),
            ...(el.automationId ? { automationId: el.automationId.slice(0, 200) } : {})
          }
        else step.positional = true
      } else if (t?.kind === 'text' && t.ref) step.text = t.ref
      else if (t) step.positional = true
      return step
    }
    case 'keys':
      return { tool: 'keys', combo: str(input.combo) ?? '' }
    case 'navigate':
      return { tool: 'navigate', url: str(input.url) ?? '' }
    case 'launch_app':
      return { tool: 'launch_app', app: str(input.app) ?? '' }
    case 'wait_for': {
      const c = input.condition as { kind?: string; value?: string; role?: string } | undefined
      if (!c?.value || !['window_title', 'element', 'text'].includes(c.kind ?? '')) return null
      return {
        tool: 'wait_for',
        wait: {
          kind: c.kind as 'window_title' | 'element' | 'text',
          value: c.value,
          ...(c.role ? { role: c.role } : {})
        },
        ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {})
      }
    }
    default:
      return null
  }
}

export function traceRecorder(
  element: Lookup = (id) => elementIndex(currentContext()?.uia).get(id)
): RunTrace {
  const steps: TraceStep[] = []
  return {
    steps,
    before: (tool, input) => traceStep(tool, input, element),
    after: (step) => {
      if (steps.length < MAX_TRACE_STEPS) steps.push(step)
    }
  }
}
