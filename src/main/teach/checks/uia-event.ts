// uia-event: a UIA event (focus, invoke, value, selection, window opened) on an element that
// matches {name, role, automationId, value}. Names and roles compare case-insensitively.
// Until 02 sends invoke/selection/value events, focus events stand in for "selected" and
// "value" (Settings moves focus with the selection), and evaluate() reads the element now.
// window-opened reads the foreground window's title, else a window / dialog element in the
// snapshot (or the match's own role). A value check with `changed` passes only when the
// element's value differs from its value when the step began (a dialog field that applies
// only on OK, so no bridge can see it yet).
import type { CheckSpec, UiaEventKind, ValueMatch } from '../lesson'
import type { CheckResult, UiaEvent } from '../ports'
import type { CheckContext, CheckHandle } from './types'
import { settleable } from './types'
import { selectedNow, withToggleValue } from './element-state'

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

/** Roles a window-opened check accepts from a snapshot when the match names no role. */
const WINDOW_ROLES = new Set(['window', 'dialog'])

/** A found element that is the window itself, not a same-named button or tab. */
function isWindowHit(m: Match, el: { role?: string }): boolean {
  return m.role !== undefined || WINDOW_ROLES.has(norm(el.role))
}

/** The foreground window is the one the match names (by title; a role of window / dialog). */
function foregroundMatches(m: Match, title: string | undefined): boolean {
  if (m.name === undefined || m.automationId !== undefined || m.value !== undefined) return false
  if (m.role !== undefined && !WINDOW_ROLES.has(norm(m.role))) return false
  return norm(m.name) === norm(title)
}

/** Event kinds that can show `event` happened. */
export function kindsFor(event: UiaEventKind): UiaEventKind[] {
  if (event === 'selected' || event === 'value') return [event, 'focused']
  return [event]
}

/** The matching element's value when the step began; null when none was found. Only an
 *  exact match counts (the search falls back to names that merely contain the name). */
async function baselineValue(spec: UiaSpec, ctx: CheckContext): Promise<string | null> {
  const { name, role, automationId } = spec.match
  const exact: Match = { name, role, automationId }
  const els = await ctx.ports.uia.find({ name, role, automationId }).catch(() => null)
  const el = els
    ?.filter((e) => elementMatches(exact, e))
    .map((e) => withToggleValue(e, spec.match))
    .find((e) => e.value !== undefined)
  return el?.value !== undefined ? norm(el.value) : null
}

/** A matching element was already selected when the step began. */
async function selectedAtStart(spec: UiaSpec, ctx: CheckContext): Promise<boolean> {
  const { name, role, automationId } = spec.match
  const els = await ctx.ports.uia.find({ name, role, automationId }).catch(() => null)
  return !!els?.some((el) => elementMatches(spec.match, el) && selectedNow(el))
}

/**
 * `absent`: holds unless the event is seen during the step. It never passes on its own (its
 * result settles only on cancel); evaluate() says fail once seen, else pass, and `vetoed()`
 * lets an allOf hold back a live pass (a Cancel click before Settings closed).
 */
function absent(spec: UiaSpec, ctx: CheckContext): CheckHandle {
  const r = settleable()
  let seen = false
  const unsubscribe = ctx.ports.uia.subscribe(kindsFor(spec.event), (e) => {
    if (seen || !elementMatches(spec.match, e.element)) return
    seen = true
    ctx.log(`uia ${e.kind} "${e.element.name ?? ''}" seen, which the step must not see`)
  })
  return {
    result: r.promise,
    evaluate: async () => (seen ? 'fail' : 'pass'),
    vetoed: () => seen,
    cancel: () => {
      unsubscribe()
      r.settle('unknown')
    }
  }
}

export function start(spec: UiaSpec, ctx: CheckContext): CheckHandle {
  if (spec.absent) return absent(spec, ctx)
  const r = settleable()
  const changedOnly = spec.event === 'value' && spec.changed === true
  const baseline = changedOnly ? baselineValue(spec, ctx) : Promise.resolve(null)
  const wasSelected =
    spec.event === 'selected' ? selectedAtStart(spec, ctx) : Promise.resolve(false)
  /** `changed`: the value differs from the baseline (without one, only a real value event). */
  const changed = async (value: string | undefined, kind?: string): Promise<boolean> => {
    if (value === undefined) return false
    const before = await baseline
    return before === null ? kind === 'value' : norm(value) !== before
  }
  const unsubscribe = ctx.ports.uia.subscribe(kindsFor(spec.event), (e) => {
    const el = withToggleValue(e.element, spec.match)
    if (!elementMatches(spec.match, el)) return
    if (changedOnly) {
      void changed(el.value, e.kind).then((yes) => {
        if (!yes) return
        ctx.log(`uia ${e.kind} "${e.element.name ?? ''}" changed`)
        r.settle('pass')
      })
      return
    }
    ctx.log(`uia ${e.kind} "${e.element.name ?? ''}" matched`)
    r.settle('pass')
  })

  // A dialog is usually the foreground window itself (the snapshot root, which the element
  // search skips), so its title counts; else a window / dialog element, never a same-named
  // button or tab. Covers a window-opened event that fired before the step subscribed.
  const windowOpenedNow = async (): Promise<CheckResult> => {
    const w = await ctx.ports.window.activeWindow().catch(() => null)
    if (w && foregroundMatches(spec.match, w.title)) return 'pass'
    const { name, role, automationId } = spec.match
    const els = await ctx.ports.uia.find({ name, role, automationId }).catch(() => null)
    if (!els) return w ? 'fail' : 'unknown'
    const hits = els.filter((el) => elementMatches(spec.match, el) && isWindowHit(spec.match, el))
    return hits.length ? 'pass' : 'fail'
  }

  const evaluate = async (): Promise<CheckResult> => {
    if (r.passed()) return 'pass'
    if (spec.event === 'invoked') return 'unknown'
    if (spec.event === 'window-opened') return windowOpenedNow()
    const { name, role, automationId } = spec.match
    const els = await ctx.ports.uia.find({ name, role, automationId }).catch(() => null)
    if (!els) return 'unknown'
    const hits = els.filter((el) => elementMatches(spec.match, withToggleValue(el, spec.match)))
    if (changedOnly) {
      if ((await baseline) === null) return 'unknown'
      for (const el of hits) if (await changed(withToggleValue(el, spec.match).value)) return 'pass'
      return els.length ? 'fail' : 'unknown'
    }
    if (spec.event === 'value') return hits.length ? 'pass' : els.length ? 'fail' : 'unknown'
    // focused / selected: the matching element has focus now (or, for selected, is selected).
    // A selection that was already there when the step began proves nothing: ask instead.
    if (hits.some((el) => el.focused === true)) return 'pass'
    if (spec.event === 'selected' && hits.some(selectedNow))
      return (await wasSelected) ? 'unknown' : 'pass'
    return els.length ? 'fail' : 'unknown'
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
