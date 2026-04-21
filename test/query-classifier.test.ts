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

  it('classifies "show me how" as guide not locate', () => {
    const r = classifyQuery('show me how to add a color grade')
    expect(r.mode).toBe('guide')
  })

  it('classifies "write an email" as action with planRequired', () => {
    const r = classifyQuery('could you open my Gmail and write an email to my boss that I\'m quitting')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('classifies standalone "draft a message" as action', () => {
    const r = classifyQuery('draft a message to John')
    expect(r.mode).toBe('action')
  })

  it('classifies "reply to" as action', () => {
    const r = classifyQuery('reply to the last email from Sarah')
    expect(r.mode).toBe('action')
  })

  it('forces planRequired for compose-email intent (single-verb phrasings)', () => {
    const r = classifyQuery('can you write an email to my boss that I\'m quitting')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('forces planRequired for "send an email"', () => {
    const r = classifyQuery('send an email to John saying hi')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('forces planRequired for "tell my boss"', () => {
    const r = classifyQuery('tell my boss I need a day off')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('routes research intent to action+planner, not locate', () => {
    const r = classifyQuery('show me the positions for ExNIS internships this summer')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('routes "find me news about X" as research', () => {
    const r = classifyQuery('find me the latest news about the election')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('still routes "show me the Compose button" as locate', () => {
    const r = classifyQuery('show me the Compose button')
    expect(r.mode).toBe('locate')
  })

  it('routes "find the best internship" as research', () => {
    const r = classifyQuery('can you find the best internship for computer scientists')
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })

  it('routes "which is the best restaurant" as research', () => {
    const r = classifyQuery("which is the best restaurant nearby")
    expect(r.mode).toBe('action')
    expect(r.planRequired).toBe(true)
  })
})
