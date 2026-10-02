// uia-event evaluate reads selection / toggle state from the snapshot (T15-G6).
import { describe, expect, it } from 'vitest'
import { realClock } from '../../src/main/a11y/timings'
import { newBudget, startCheck, type CheckContext } from '../../src/main/teach/checks'
import {
  selectedNow,
  toggleCounts,
  withToggleValue
} from '../../src/main/teach/checks/element-state'
import type { CheckSpec, LessonStep } from '../../src/main/teach/lesson'
import { noopPorts } from '../../src/main/teach/ports'
import type { ElementNode } from '@shared/types'

const STEP: LessonStep = {
  id: 's',
  say: 'Do it.',
  target: null,
  check: { type: 'manual' },
  hints: []
}

const el = (role: string, name: string, extra: Partial<ElementNode> = {}): ElementNode => ({
  id: 'e1',
  role,
  name,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  monitorId: 0,
  enabled: true,
  patterns: [],
  ...extra
})

/** Evaluates `check` on `nodes`; the step began on `atStart` (default: nothing found). */
async function evaluate(
  check: CheckSpec,
  nodes: ElementNode[],
  atStart: ElementNode[] = []
): Promise<string> {
  let found = atStart
  const ctx: CheckContext = {
    ports: noopPorts({ uia: { find: async () => found, subscribe: () => () => {} } }),
    clock: realClock,
    step: STEP,
    budget: newBudget(),
    log: () => {}
  }
  const h = startCheck(check, ctx)
  await new Promise((r) => setImmediate(r))
  found = nodes
  return h.evaluate().finally(() => h.cancel())
}

describe('element state helpers', () => {
  it('uses the toggle state only when there is no value', () => {
    const box = { role: 'CheckBox' }
    expect(withToggleValue({ toggled: 'on' as const }, box).value).toBe('on')
    expect(withToggleValue({ value: 'Yes', toggled: 'off' as const }, box).value).toBe('Yes')
    expect(withToggleValue({}, box).value).toBeUndefined()
    expect(selectedNow({ selected: true })).toBe(true)
    expect(selectedNow({ selected: false })).toBe(false)
    expect(selectedNow({})).toBe(false)
  })

  it('counts a toggle state only for a literal on / off / mixed or a toggle role', () => {
    expect(toggleCounts({ name: 'Bold', value: 'ON' })).toBe(true)
    expect(toggleCounts({ name: 'Wrap', role: 'Button', value: { regex: '.+' } })).toBe(true)
    expect(toggleCounts({ name: 'Dark', role: 'RadioButton' })).toBe(true)
    expect(toggleCounts({ name: 'Search', value: { regex: '\\S' } })).toBe(false)
    expect(toggleCounts({ name: 'Search', role: 'Edit', value: 'on' })).toBe(true)
    expect(toggleCounts({ name: 'Search', role: 'Edit' })).toBe(false)
    expect(toggleCounts(undefined)).toBe(false)
  })
})

describe('uia-event evaluate with snapshot state', () => {
  const tabCheck: CheckSpec = {
    type: 'uia-event',
    event: 'selected',
    match: { name: 'notes.txt', role: 'TabItem' }
  }
  const boxCheck: CheckSpec = {
    type: 'uia-event',
    event: 'value',
    match: { name: 'Header Row', role: 'CheckBox', value: 'On' }
  }

  it('a selected tab passes a selected step without focus', async () => {
    expect(await evaluate(tabCheck, [el('tabitem', 'notes.txt', { selected: true })])).toBe('pass')
    expect(await evaluate(tabCheck, [el('tabitem', 'notes.txt', { selected: false })])).toBe('fail')
    expect(await evaluate(tabCheck, [el('tabitem', 'notes.txt')])).toBe('fail')
  })

  it('a tab already selected when the step began asks instead of passing', async () => {
    const selected = [el('tabitem', 'notes.txt', { selected: true })]
    expect(await evaluate(tabCheck, selected, selected)).toBe('unknown')
    const before = [el('tabitem', 'notes.txt', { selected: false })]
    expect(await evaluate(tabCheck, selected, before)).toBe('pass')
  })

  it('selection does not count for a focused step', async () => {
    const focusCheck: CheckSpec = { ...tabCheck, event: 'focused' } as CheckSpec
    expect(await evaluate(focusCheck, [el('tabitem', 'notes.txt', { selected: true })])).toBe(
      'fail'
    )
  })

  it('a check box value check reads its toggle state', async () => {
    expect(await evaluate(boxCheck, [el('checkbox', 'Header Row', { toggled: 'on' })])).toBe('pass')
    expect(await evaluate(boxCheck, [el('checkbox', 'Header Row', { toggled: 'off' })])).toBe(
      'fail'
    )
    expect(await evaluate(boxCheck, [el('checkbox', 'Header Row', { toggled: 'mixed' })])).toBe(
      'fail'
    )
    expect(await evaluate(boxCheck, [el('checkbox', 'Header Row')])).toBe('fail')
  })

  it('a regex value check without a toggle role ignores a same-named toggle', async () => {
    const typed: CheckSpec = {
      type: 'uia-event',
      event: 'value',
      match: { name: 'Search', value: { regex: '\\S' } }
    }
    expect(await evaluate(typed, [el('button', 'Search', { toggled: 'off' })])).toBe('fail')
    expect(await evaluate(typed, [el('edit', 'Search', { value: 'query' })])).toBe('pass')
  })
})
