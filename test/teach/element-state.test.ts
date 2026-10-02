// uia-event evaluate reads selection / toggle state from the snapshot (T15-G6).
import { describe, expect, it } from 'vitest'
import { realClock } from '../../src/main/a11y/timings'
import { newBudget, startCheck, type CheckContext } from '../../src/main/teach/checks'
import { selectedNow, withToggleValue } from '../../src/main/teach/checks/element-state'
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

function evaluate(check: CheckSpec, nodes: ElementNode[]): Promise<string> {
  const ctx: CheckContext = {
    ports: noopPorts({ uia: { find: async () => nodes, subscribe: () => () => {} } }),
    clock: realClock,
    step: STEP,
    budget: newBudget(),
    log: () => {}
  }
  const h = startCheck(check, ctx)
  return h.evaluate().finally(() => h.cancel())
}

describe('element state helpers', () => {
  it('uses the toggle state only when there is no value', () => {
    expect(withToggleValue({ toggled: 'on' as const }).value).toBe('on')
    expect(withToggleValue({ value: 'Yes', toggled: 'off' as const }).value).toBe('Yes')
    expect(withToggleValue({}).value).toBeUndefined()
    expect(selectedNow({ selected: true })).toBe(true)
    expect(selectedNow({ selected: false })).toBe(false)
    expect(selectedNow({})).toBe(false)
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
})
