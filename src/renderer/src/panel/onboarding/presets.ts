// Picker cards for the first onboarding step. The settings each one applies, and how
// combinations merge, live in @shared/profiles.
import { PROFILE_IDS, PROFILES, type ProfileId } from '@shared/profiles'
import type { IconName } from '../../ui'

const ICON: Record<ProfileId, IconName> = {
  standard: 'mouse',
  'motor-voice': 'mic',
  'motor-pointer': 'click',
  'eye-gaze': 'eye',
  switch: 'toggle',
  'low-vision': 'zoom',
  blind: 'volume',
  'deaf-hoh': 'captions',
  speech: 'message',
  cognitive: 'sparkles'
}

export interface PresetCard {
  id: ProfileId
  icon: IconName
  title: string
  description: string
}

export const PRESET_CARDS: PresetCard[] = PROFILE_IDS.map((id) => ({
  id,
  icon: ICON[id],
  title: PROFILES[id].choice,
  description: PROFILES[id].description
}))

/** Toggles a card; "mouse and keyboard" and the others are not exclusive. */
export function toggleChoice(chosen: readonly ProfileId[], id: ProfileId): ProfileId[] {
  return chosen.includes(id)
    ? chosen.filter((c) => c !== id)
    : PROFILE_IDS.filter((p) => p === id || chosen.includes(p))
}
