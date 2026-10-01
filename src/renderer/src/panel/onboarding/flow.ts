// Onboarding step order. Every step can be skipped; steps that need features which are not
// built yet stay behind flags.
import type { KeyProvider } from '@shared/channels'
import type { CompatiblePreset } from '@shared/config'
import { GEMINI_KEYS_URL } from '@shared/model-providers'

export type StepId =
  | 'profile'
  | 'key'
  | 'voice'
  | 'memory'
  | 'try'
  | 'point'
  | 'numbers'
  | 'lesson'
  | 'done'

export interface FlowFlags {
  /** Practice board: "watch me point" and "show numbers". */
  practice: boolean
  /** Mini lesson on the practice board (07 lesson engine). */
  lesson: boolean
}

export const FLOW_FLAGS: FlowFlags = { practice: true, lesson: true }

export const STEP_TITLES: Record<StepId, string> = {
  profile: 'How you use your PC',
  key: 'Connect an AI',
  voice: 'Your voice',
  memory: 'Remembering',
  try: 'Try it',
  point: 'Watch me point',
  numbers: 'Show numbers',
  lesson: 'Mini lesson',
  done: 'All set'
}

export function buildSteps(flags: FlowFlags = FLOW_FLAGS): StepId[] {
  const practice: StepId[] = flags.practice ? ['point', 'numbers'] : []
  return [
    'profile',
    'key',
    'voice',
    'memory',
    'try',
    ...practice,
    ...(flags.lesson ? (['lesson'] as StepId[]) : []),
    'done'
  ]
}

export function nextStep(steps: StepId[], cur: StepId): StepId {
  const i = steps.indexOf(cur)
  return steps[Math.min(steps.length - 1, i + 1)]
}

export function prevStep(steps: StepId[], cur: StepId): StepId {
  const i = steps.indexOf(cur)
  return steps[Math.max(0, i - 1)]
}

/** "Step 2 of 6". */
export function stepLabel(steps: StepId[], cur: StepId): string {
  return `Step ${steps.indexOf(cur) + 1} of ${steps.length}`
}

/** Memory facts for the chosen access needs ("Access needs" section of the profile). */
export const ACCESS_FACTS: Record<string, string> = {
  'motor-voice': 'Controls the PC by voice',
  'motor-pointer': 'Uses dwell clicking',
  'eye-gaze': 'Uses eye gaze',
  switch: 'Uses switch access',
  'low-vision': 'Has low vision and prefers large, high-contrast text',
  blind: 'Uses a screen reader',
  'deaf-hoh': 'Is deaf or hard of hearing and prefers text',
  speech: 'Finds speaking hard and may type instead',
  cognitive: 'Prefers simple help, one step at a time'
}

export function accessFacts(ids: readonly string[]): string[] {
  return ids.map((id) => ACCESS_FACTS[id]).filter((t): t is string => !!t)
}

/** How to start talking, worded for the chosen activation. */
export function talkHint(o: { hotkey: string; tap: boolean; wake: string | null }): string {
  const key = o.hotkey.split('+').join(' + ')
  const verb = o.tap ? 'tap' : 'hold'
  const tail = o.tap ? `${key}, then ask` : `${key} and ask`
  return o.wake ? `Say “${o.wake}”, or ${verb} ${tail}` : `${o.tap ? 'Tap' : 'Hold'} ${tail}`
}

/** Where to get a key, per provider. All offer keys without a subscription; Gemini's is free. */
export const KEY_LINKS = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: GEMINI_KEYS_URL
} as const

/** Rough check before sending a pasted key to main (main validates again). */
export function looksLikeKey(provider: KeyProvider, key: string): boolean {
  const k = key.trim()
  if (!/^[A-Za-z0-9_\-.]{20,300}$/.test(k)) return false
  if (provider === 'anthropic') return k.startsWith('sk-ant-')
  if (provider === 'openai') return k.startsWith('sk-') && !k.startsWith('sk-ant-')
  // Gemini and other services: formats vary, the test call decides.
  return true
}

/** Guess the provider from a pasted key so the user doesn't have to pick. */
export function guessProvider(key: string): KeyProvider | null {
  const k = key.trim()
  if (k.startsWith('sk-ant-')) return 'anthropic'
  if (guessPreset(k)) return 'compatible'
  if (k.startsWith('sk-')) return 'openai'
  if (k.startsWith('AIza')) return 'gemini'
  return null
}

/** The OpenAI-compatible service a key belongs to, when its prefix says so. */
export function guessPreset(key: string): CompatiblePreset | null {
  const k = key.trim()
  if (k.startsWith('sk-or-')) return 'openrouter'
  if (k.startsWith('gsk_')) return 'groq'
  return null
}
