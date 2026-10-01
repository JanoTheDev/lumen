// Policy for lesson-originated "do it for me" actions. These come from skill pack data, never
// from model output, and only run after the user asked ("do it for me" or yes to the offer).
// So the model policy's confirm-level keys are fine here, while the hard denies stay, and
// ms-settings: pages may open (a narrow allowlist next to the usual https).
import { isSafeUrl, normalizeCombo } from '../actions/safety'

const DENY_KEYS = new Set(['win+r', 'win+x', 'ctrl+alt+del', 'alt+f4'])

const MS_SETTINGS_RE = /^ms-settings:[a-z0-9-]+(?:[?#][a-z0-9=&_-]*)?$/i

export function lessonKeysAllowed(combo: string): boolean {
  return !DENY_KEYS.has(normalizeCombo(combo))
}

/** https (model policy) or a plain ms-settings: page. */
export function lessonUrlAllowed(url: string): boolean {
  if (MS_SETTINGS_RE.test(url)) return true
  return url.startsWith('https://') && isSafeUrl(url)
}
