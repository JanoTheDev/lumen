import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/query/context', () => ({ currentContext: () => null }))

import type { ElementNode } from '@shared/types'
import { MAX_TRACE_STEPS, traceRecorder, traceStep } from '../../src/main/agent-mode/trace'

const nodes: Record<string, ElementNode> = {
  e1: {
    id: 'e1',
    name: 'Send',
    role: 'button',
    automationId: 'send',
    rect: { x: 0, y: 0, w: 1, h: 1 },
    monitorId: 0,
    enabled: true,
    patterns: []
  }
}
const lookup = (id: string): ElementNode | undefined => nodes[id]

describe('run trace (11 T09)', () => {
  it('keeps element identity, not ids', () => {
    expect(
      traceStep('act', { op: 'invoke', target: { kind: 'element', ref: 'e1' } }, lookup)
    ).toEqual({
      tool: 'act',
      op: 'invoke',
      element: { name: 'Send', role: 'button', automationId: 'send' }
    })
    expect(
      traceStep('act', { op: 'click', target: { kind: 'element', ref: 'e9' } }, lookup)
    ).toMatchObject({
      positional: true
    })
    expect(
      traceStep('act', { op: 'click', target: { kind: 'mark', ref: '3' } }, lookup)
    ).toMatchObject({
      positional: true
    })
    expect(traceStep('act', { op: 'type', value: 'hi' }, lookup)).toEqual({
      tool: 'act',
      op: 'type',
      value: 'hi'
    })
    expect(traceStep('observe', { what: 'screen' }, lookup)).toBeNull()
    expect(
      traceStep(
        'wait_for',
        { condition: { kind: 'text', value: 'Saved' }, timeoutMs: 3000 },
        lookup
      )
    ).toEqual({ tool: 'wait_for', wait: { kind: 'text', value: 'Saved' }, timeoutMs: 3000 })
  })

  it('records only calls that worked, capped', () => {
    const t = traceRecorder(lookup)
    for (let i = 0; i < MAX_TRACE_STEPS + 3; i++) {
      const s = t.before('keys', { combo: 'tab' })
      if (s) t.after(s)
    }
    expect(t.steps).toHaveLength(MAX_TRACE_STEPS)
  })
})
