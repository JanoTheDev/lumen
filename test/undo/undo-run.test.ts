import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

let undoOn = true
vi.mock('../../src/main/config', () => ({
  loadConfig: () => ({ helpers: { undo: undoOn } })
}))
vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => null }))
vi.mock('../../src/main/query/context', () => ({ currentContext: () => null }))

import { recentlyActed, recordUndo, undoLast, undoStack } from '../../src/main/undo'

describe('undo runtime', () => {
  beforeEach(() => {
    undoOn = true
    undoStack().clear()
  })

  it('records only after the action ran (commit), and only when on', async () => {
    const commit = await recordUndo({ type: 'type', text: 'hello' }, { taskId: 't1' })
    expect(undoStack().size).toBe(0)
    commit!()
    expect(undoStack().size).toBe(1)
    expect(recentlyActed()).toBe(true)
    undoOn = false
    expect(await recordUndo({ type: 'type', text: 'x' }, { taskId: 't1' })).toBeNull()
    expect(recentlyActed()).toBe(false)
  })

  it('"undo that" runs the reversal and drops the record', async () => {
    ;(await recordUndo({ type: 'hotkey', keys: ['ctrl', 'v'] }, { taskId: 't1' }))!()
    const run = vi.fn(async () => ({ executed: 1, blocked: false, cancelled: false }))
    const text = await undoLast(1, { run })
    expect(run).toHaveBeenCalledWith([{ type: 'input', steps: [{ t: 'keys', combo: 'ctrl+z' }] }])
    expect(text).toContain('Undone: pressed Ctrl+V')
    expect(await undoLast(1, { run })).toBe('There is nothing of mine to undo.')
  })

  it('a blocked reversal is reported and kept', async () => {
    ;(await recordUndo({ type: 'type', text: 'abc' }, { taskId: 't1' }))!()
    const text = await undoLast(1, {
      run: async () => ({ executed: 0, blocked: true, cancelled: false })
    })
    expect(text).toBe('Not undone: typed 3 characters, because the safety check stopped it.')
    expect(undoStack().size).toBe(1)
  })

  it('an irreversible step is said plainly', async () => {
    ;(await recordUndo({ type: 'click_element', text: 'Send' }, { taskId: 't1' }))!()
    const run = vi.fn()
    const text = await undoLast('task', { run })
    expect(run).not.toHaveBeenCalled()
    expect(text).toBe('Not undone: clicked “Send”, because “Send” can’t be taken back.')
  })
})
