import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ModelResponse } from '@shared/types'
import { CancelScope, CancelledError } from '../../src/main/query/cancel'
import { mergeSplit, recordSplitHistory, runParallelSplit } from '../../src/main/query/parallel'
import { clearHistory, historyMessages } from '../../src/main/ai/history'
import { setConfigDir } from '../../src/main/config'
import { tempDir } from '../helpers/fixtures'

const answer = (text: string): ModelResponse => ({ mode: 'answer', text, spoken: text })

// Resolves after `ms`, or rejects as soon as the child scope is cancelled.
function slow(text: string, ms: number, scope: CancelScope): Promise<ModelResponse> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(answer(text)), ms)
    scope.signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new CancelledError())
    })
  })
}

describe('runParallelSplit', () => {
  it('aborts every sub-query when the parent turn is cancelled', async () => {
    const parent = new CancelScope()
    const children: CancelScope[] = []
    const run = runParallelSplit(['weather?', 'time?'], parent, (q, child) => {
      children.push(child)
      return slow(q, 1000, child)
    })
    parent.cancel()
    await expect(run).rejects.toBeInstanceOf(CancelledError)
    expect(children).toHaveLength(2)
    expect(children.every((c) => c.signal.aborted)).toBe(true)
  })

  it('cancels the siblings when one sub-query fails', async () => {
    const parent = new CancelScope()
    const children: CancelScope[] = []
    const run = runParallelSplit(['a', 'b'], parent, (q, child) => {
      children.push(child)
      return q === 'a' ? Promise.reject(new Error('boom')) : slow(q, 1000, child)
    })
    await expect(run).rejects.toThrow('boom')
    expect(children[1].signal.aborted).toBe(true)
    expect(parent.cancelled).toBe(false)
  })

  it('returns results in the original order whatever order they finish in', async () => {
    const parent = new CancelScope()
    const results = await runParallelSplit(['first', 'second', 'third'], parent, (q, child) =>
      slow(`${q} answer`, q === 'first' ? 30 : q === 'second' ? 1 : 15, child)
    )
    expect(results.map((r) => r.query)).toEqual(['first', 'second', 'third'])
    expect(mergeSplit(results)).toEqual({
      mode: 'answer',
      text: '**first**\nfirst answer\n\n**second**\nsecond answer\n\n**third**\nthird answer',
      spoken: 'first answer second answer third answer'
    })
  })
})

describe('recordSplitHistory', () => {
  let cleanup: () => void
  beforeEach(() => {
    const t = tempDir()
    cleanup = t.cleanup
    setConfigDir(t.dir)
    clearHistory()
  })
  afterEach(() => {
    clearHistory()
    setConfigDir(null)
    cleanup()
  })

  it('gives each sub-query its own history slot in a deterministic order', async () => {
    const parent = new CancelScope()
    const results = await runParallelSplit(
      ['what time is it', 'what is the weather'],
      parent,
      (q, child) =>
        // The second finishes first.
        slow(q.toUpperCase(), q.startsWith('what time') ? 20 : 1, child)
    )
    recordSplitHistory(results, (r) => (r.mode === 'answer' ? r.text : ''))
    expect(historyMessages()).toEqual([
      { role: 'user', content: 'what time is it' },
      { role: 'assistant', content: 'WHAT TIME IS IT' },
      { role: 'user', content: 'what is the weather' },
      { role: 'assistant', content: 'WHAT IS THE WEATHER' }
    ])
  })
})
