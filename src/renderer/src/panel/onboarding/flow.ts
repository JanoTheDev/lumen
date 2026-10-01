// Onboarding step order. Every step can be skipped; steps that need features which are not
// built yet stay behind flags.

export type StepId = 'profile' | 'key' | 'voice' | 'memory' | 'try' | 'done'

export interface FlowFlags {
  /** Practice page with the pointing buddy, "show numbers" and the mini lesson. */
  practice: boolean
}

export const FLOW_FLAGS: FlowFlags = { practice: false }

export const STEP_TITLES: Record<StepId, string> = {
  profile: 'How you use your PC',
  key: 'Connect an AI',
  voice: 'Your voice',
  memory: 'Remembering',
  try: 'Try it',
  done: 'All set'
}

export function buildSteps(): StepId[] {
  return ['profile', 'key', 'voice', 'memory', 'try', 'done']
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

/** Where to get a key, per provider. Both offer pay-as-you-go keys without a subscription. */
export const KEY_LINKS = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys'
} as const

/** Rough check before sending a pasted key to main (main validates again). */
export function looksLikeKey(provider: 'anthropic' | 'openai', key: string): boolean {
  const k = key.trim()
  if (!/^[A-Za-z0-9_\-.]{20,300}$/.test(k)) return false
  return provider === 'anthropic' ? k.startsWith('sk-ant-') : k.startsWith('sk-')
}

/** Guess the provider from a pasted key so the user doesn't have to pick. */
export function guessProvider(key: string): 'anthropic' | 'openai' | null {
  const k = key.trim()
  if (k.startsWith('sk-ant-')) return 'anthropic'
  if (k.startsWith('sk-')) return 'openai'
  return null
}
