// Element state a UIA snapshot carries (selected / toggled), so a uia-event check can tell a
// step is done without having seen the event: a selected tab or item counts for "selected",
// and a check box's toggle state ("on" / "off" / "mixed") stands in for a missing value.
import type { ElementNode } from '@shared/types'
import type { CheckSpec } from '../lesson'

type StateNode = Pick<ElementNode, 'value' | 'selected' | 'toggled'>
type Match = Extract<CheckSpec, { type: 'uia-event' }>['match']

const TOGGLE_VALUES = new Set(['on', 'off', 'mixed'])
const TOGGLE_ROLES = new Set(['checkbox', 'button', 'radiobutton'])

const norm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Whether a toggle state may stand in for the value this match wants: only a literal
 * on / off / mixed, or a match on a check box, button or radio button. Never for a bare
 * regex, which a same-named toggle would otherwise satisfy before the user typed anything.
 */
export function toggleCounts(m: Match | undefined): boolean {
  if (!m) return false
  if (typeof m.value === 'string' && TOGGLE_VALUES.has(norm(m.value))) return true
  return m.role !== undefined && TOGGLE_ROLES.has(norm(m.role))
}

/** The element with its toggle state as its value when it has no value of its own and the
 *  match lets a toggle state count (`toggleCounts`). */
export function withToggleValue<T extends StateNode>(el: T, m: Match | undefined): T {
  return el.value === undefined && el.toggled !== undefined && toggleCounts(m)
    ? { ...el, value: el.toggled }
    : el
}

/** A "selected" step reads as done when the element is selected now (its pattern says so). */
export function selectedNow(el: Pick<ElementNode, 'selected'>): boolean {
  return el.selected === true
}
