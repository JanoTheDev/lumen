import { describe, expect, it } from 'vitest'
import { parseProactiveRule, reminderLine, ruleMatches } from '../../src/main/routines/proactive'

describe('rules', () => {
  it('parses spoken rules', () => {
    expect(parseProactiveRule('When I open Resolve, remind me to back up.')).toEqual({
      app: 'Resolve',
      say: 'Remember to back up.'
    })
    expect(parseProactiveRule('whenever I start Blender tell me to save often')).toEqual({
      app: 'Blender',
      say: 'Save often.'
    })
    expect(
      parseProactiveRule('every time I open the Excel app remind me about the budget')
    ).toEqual({ app: 'Excel', say: 'Reminder: the budget.' })
    expect(parseProactiveRule('open Resolve')).toBeNull()
    expect(parseProactiveRule('remind me to back up')).toBeNull()
  })

  it('reminder lines', () => {
    expect(reminderLine('remind me to', 'stretch')).toBe('Remember to stretch.')
    expect(reminderLine('remind me about', 'the budget')).toBe('Reminder: the budget.')
    expect(reminderLine('say', 'time for lunch!')).toBe('Time for lunch!')
  })

  it('matches by process or window title', () => {
    expect(ruleMatches('Resolve', { process: 'Resolve.exe' })).toBe(true)
    expect(ruleMatches('DaVinci Resolve', { process: 'Resolve.exe' })).toBe(true)
    expect(ruleMatches('blender', { process: 'blender.exe' })).toBe(true)
    expect(ruleMatches('Excel', { process: 'EXCEL.EXE' })).toBe(true)
    expect(
      ruleMatches('Word', { process: 'chrome.exe', title: 'Microsoft Word tips - Chrome' })
    ).toBe(true)
    expect(ruleMatches('Word', { process: 'chrome.exe', title: 'Wordle - Chrome' })).toBe(false)
    expect(ruleMatches('Resolve', { process: 'explorer.exe', title: 'Downloads' })).toBe(false)
  })
})
