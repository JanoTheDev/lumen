// Element state a UIA snapshot carries (selected / toggled), so a uia-event check can tell a
// step is done without having seen the event: a selected tab or item counts for "selected",
// and a check box's toggle state ("on" / "off" / "mixed") stands in for a missing value.
import type { ElementNode } from '@shared/types'

type StateNode = Pick<ElementNode, 'value' | 'selected' | 'toggled'>

/** The element with its toggle state as its value when it has no value of its own. */
export function withToggleValue<T extends StateNode>(el: T): T {
  return el.value === undefined && el.toggled !== undefined ? { ...el, value: el.toggled } : el
}

/** A "selected" step reads as done when the element is selected now (its pattern says so). */
export function selectedNow(el: Pick<ElementNode, 'selected'>): boolean {
  return el.selected === true
}
