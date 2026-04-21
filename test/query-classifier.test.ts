import { describe, it, expect } from 'vitest'
import { classifyQuery } from '../src/main/query-classifier'

describe('classifyQuery', () => {
  it('classifies pure questions as answer mode', () => {
    const r = classifyQuery('what is the capital of France?')
    expect(r.mode).toBe('answer')
    expect(r.planRequired).toBe(false)
    expect(r.isContinuation).toBe(false)
  })

  it('classifies single action as action mode', () => {
    const r = classifyQuery('open Gmail')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(false)
  })

  it('classifies multi-intent as action mode with planRequired', () => {
    const r = classifyQuery('open gmail and compose email to my boss')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('classifies locate queries', () => {
    const r = classifyQuery('where is the compose button')
    expect(r.mode).toBe('locate')
  })

  it('detects continuation intent', () => {
    const continuations = ['do it', 'yes go ahead', 'just do it', 'yes', 'go ahead']
    for (const c of continuations) {
      expect(classifyQuery(c).isContinuation).toBe(true)
    }
  })

  it('classifies "how do I" as guide mode', () => {
    const r = classifyQuery('how do I add a color grade in DaVinci Resolve')
    expect(r.mode).toBe('guide')
  })
})
