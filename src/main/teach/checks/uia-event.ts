// uia-event: a UIA event (focus, invoke, value, selection, window opened) on an element that
// matches {name, role, automationId, value}. Names and roles compare case-insensitively.
// Until 02 sends invoke/selection/value events, focus events stand in for "selected" and
// "value" (Settings moves focus with the selection), and evaluate() reads the element now.
import type { CheckSpec, UiaEventKind, ValueMatch } from '../lesson'
import type { CheckResult, UiaEvent } from '../ports'
import type { CheckContext, CheckHandle } from './types'
import { settleable } from './types'

type UiaSpec = Extract<CheckSpec, { type: 'uia-event' }>
type Match = UiaSpec['match']

const norm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

export function valueMatches(want: ValueMatch, value: string | undefined): boolean {
  if (value === undefined) return false
  if (typeof want === 'string') return norm(want) === norm(value)
  try {
    return new RegExp(want.regex, 'i').test(value)
  } catch {
    return false
  }
}

export function elementMatches(m: Match, el: UiaEvent['element']): boolean {
  if (m.name !== undefined && norm(m.name) !== norm(el.name)) return false
  if (m.role !== undefined && norm(m.role) !== norm(el.role)) return false
  if (m.automationId !== undefined && m.automationId !== el.automationId) return false
  if (m.value !== undefined && !valueMatches(m.value, el.value)) return false
  return true
}

/** Event kinds that can show `event` happened. */
export function kindsFor(event: UiaEventKind): UiaEventKind[] {
  if (event === 'selected' || event === 'value') return [event, 'focused']
  return [event]
}

export function start(spec: UiaSpec, ctx: CheckContext): CheckHandle {
  const r = settleable()
  const unsubscribe = ctx.ports.uia.subscribe(kindsFor(spec.event), (e) => {
    if (elementMatches(spec.match, e.element)) {
      ctx.log(`uia ${e.kind} "${e.element.name ?? ''}" matched`)
      r.settle('pass')
    }
  })

  const evaluate = async (): Promise<CheckResult> => {
    if (r.passed()) return 'pass'
    if (spec.event === 'invoked') return 'unknown'
    const { name, role, automationId } = spec.match
    const els = await ctx.ports.uia.find({ name, role, automationId }).catch(() => null)
    if (!els) return 'unknown'
    const hits = els.filter((el) => elementMatches(spec.match, el))
    if (spec.event === 'window-opened') return hits.length ? 'pass' : 'fail'
    if (spec.event === 'value') return hits.length ? 'pass' : els.length ? 'fail' : 'unknown'
    // focused / selected: the matching element has focus now.
    return hits.some((el) => el.focused) ? 'pass' : els.length ? 'fail' : 'unknown'
  }

  return {
    result: r.promise,
    evaluate,
    cancel: () => {
      unsubscribe()
      r.settle('unknown')
    }
  }
}
