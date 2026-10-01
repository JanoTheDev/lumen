// Reply styles ("modes", skills with `kind: style`) as Settings and the bar see them. Pure TS.
import type { SkillTrust } from './types'

export interface StyleInfo {
  name: string
  description: string
  /** Declared levels; the first is the default. Empty = one level. */
  levels: string[]
  trust: SkillTrust
  origin: 'builtin' | 'app-pack' | 'user'
  /** Switched on in the skills list (only enabled styles can be turned on). */
  enabled: boolean
  warnings: string[]
}

/** The style in use (config `ai.style`); null = Lumen's normal wording. */
export interface ActiveStyle {
  name: string
  level?: string
}

/** "explain-like-im-new" → "explain like im new" (how the name is said). */
export function spokenStyleName(name: string): string {
  return name.replace(/-/g, ' ')
}
