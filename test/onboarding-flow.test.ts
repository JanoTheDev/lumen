import { describe, expect, it } from 'vitest'
import {
  accessFacts,
  buildSteps,
  guessProvider,
  looksLikeKey,
  nextStep,
  prevStep,
  stepLabel,
  talkHint
} from '../src/renderer/src/panel/onboarding/flow'
import { PRESET_CARDS, toggleChoice } from '../src/renderer/src/panel/onboarding/presets'
import { PROFILE_IDS } from '../src/shared/profiles'

describe('onboarding flow', () => {
  const steps = buildSteps()

  it('asks for the profile first and ends on the summary', () => {
    expect(steps[0]).toBe('profile')
    expect(steps.at(-1)).toBe('done')
    // One key screen only; no other setup screens.
    expect(steps.filter((s) => s === 'key')).toHaveLength(1)
  })

  it('adds the practice steps before the summary, the lesson only when flagged', () => {
    expect(buildSteps({ practice: true, lesson: false }).slice(-3)).toEqual([
      'point',
      'numbers',
      'done'
    ])
    expect(buildSteps({ practice: false, lesson: false })).not.toContain('point')
    expect(buildSteps({ practice: true, lesson: true })).toContain('lesson')
  })

  it('moves forward and back without leaving the list', () => {
    expect(nextStep(steps, 'profile')).toBe('key')
    expect(nextStep(steps, 'done')).toBe('done')
    expect(prevStep(steps, 'profile')).toBe('profile')
    expect(prevStep(steps, 'voice')).toBe('key')
    expect(stepLabel(steps, 'key')).toBe(`Step 2 of ${steps.length}`)
  })

  it('words the talk hint for hold, tap and wake word', () => {
    expect(talkHint({ hotkey: 'Ctrl+Shift+Space', tap: false, wake: null })).toBe(
      'Hold Ctrl + Shift + Space and ask'
    )
    expect(talkHint({ hotkey: 'F9', tap: true, wake: 'hey lumen' })).toBe(
      'Say “hey lumen”, or tap F9, then ask'
    )
  })

  it('checks and recognises pasted keys', () => {
    // Built from pieces so no committed literal looks like a real key to secret scanners.
    const ant = ['sk', 'ant', 'api03', '0123456789abcdef'].join('-')
    const proj = ['sk', 'proj', '0123456789abcdefghij'].join('-')
    expect(guessProvider(ant)).toBe('anthropic')
    expect(guessProvider(proj)).toBe('openai')
    expect(guessProvider('hello')).toBeNull()
    expect(looksLikeKey('anthropic', ant)).toBe(true)
    expect(looksLikeKey('anthropic', proj)).toBe(false)
    expect(looksLikeKey('openai', ` ${proj} `)).toBe(true)
    expect(looksLikeKey('openai', 'sk-short')).toBe(false)
  })

  it('turns access needs into memory facts', () => {
    expect(accessFacts(['standard', 'motor-pointer', 'blind'])).toEqual([
      'Uses dwell clicking',
      'Uses a screen reader'
    ])
  })
})

describe('profile picker', () => {
  it('has one card per profile', () => {
    expect(PRESET_CARDS.map((c) => c.id)).toEqual([...PROFILE_IDS])
  })

  it('toggles choices and keeps the table order', () => {
    let chosen = toggleChoice([], 'blind')
    chosen = toggleChoice(chosen, 'standard')
    expect(chosen).toEqual(['standard', 'blind'])
    expect(toggleChoice(chosen, 'standard')).toEqual(['blind'])
  })
})
