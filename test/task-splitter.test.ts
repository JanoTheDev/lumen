import { describe, it, expect } from 'vitest'
import { splitSubtasks, canParallelize, mergeAnswers } from '../src/main/task-splitter'

describe('task-splitter', () => {
  it('returns single-item array when prompt has no connectors', () => {
    expect(splitSubtasks('what is the weather')).toEqual(['what is the weather'])
  })

  it('splits on "and also"', () => {
    const parts = splitSubtasks('what is the weather and also what time is it')
    expect(parts).toEqual(['what is the weather', 'what time is it'])
  })

  it('splits on ", and" / ", then"', () => {
    const parts = splitSubtasks('summarize my inbox, and tell me the unread count')
    expect(parts.length).toBe(2)
    expect(parts[0]).toBe('summarize my inbox')
  })

  it('canParallelize true when every subtask is answer mode', () => {
    const parts = ['what is 2 plus 2', 'what time is it', 'who invented the telephone']
    expect(canParallelize(parts)).toBe(true)
  })

  it('canParallelize false when any subtask is action', () => {
    const parts = ['what is the weather', 'open Gmail']
    expect(canParallelize(parts)).toBe(false)
  })

  it('canParallelize false for single subtask', () => {
    expect(canParallelize(['what is the weather'])).toBe(false)
  })

  it('mergeAnswers labels each sub-answer with its subtask', () => {
    const merged = mergeAnswers(['Q1', 'Q2'], ['A1', 'A2'])
    expect(merged).toContain('**Q1**')
    expect(merged).toContain('A1')
    expect(merged).toContain('**Q2**')
    expect(merged).toContain('A2')
  })
})
