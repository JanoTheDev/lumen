import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/main/actions/safety'

const write = (action: string): { type: string; action: string; description: string } => ({
  type: 'write_file',
  action,
  description: 'Plan.docx in Documents\\Lumen'
})

describe('write_file policy', () => {
  it('a new file in Documents\\Lumen is low for everyone', () => {
    for (const origin of ['user-direct', 'agent', 'routine', 'mcp'] as const)
      expect(evaluate(write('default'), { origin })).toMatchObject({
        risk: 'low',
        needsConfirm: false
      })
  })

  it('elsewhere is medium for agents only', () => {
    expect(evaluate(write('elsewhere'), { origin: 'user-direct' }).risk).toBe('low')
    expect(evaluate(write('elsewhere'), { origin: 'agent' })).toMatchObject({
      risk: 'medium',
      needsConfirm: true
    })
  })

  it('replacing a file always asks', () => {
    expect(evaluate(write('replace'), { origin: 'user-direct' })).toMatchObject({
      risk: 'high',
      needsConfirm: true
    })
  })
})

describe('move_file policy', () => {
  it('is low for automations (granted folders only, never over a file, undo kept)', () => {
    expect(
      evaluate({ type: 'move_file', description: 'a.pdf → b.pdf' }, { origin: 'routine' })
    ).toMatchObject({ risk: 'low', needsConfirm: false })
  })
})
