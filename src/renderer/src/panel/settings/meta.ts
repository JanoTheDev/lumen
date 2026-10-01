// Settings sections: ids, labels, icons and search keywords. Other streams add their own
// controls in sections/<name>.tsx; the page imports them by id.
import type { Config, Patch } from './useConfig'
import { icons, type IconComponent } from '../../ui/icons'

export interface SectionProps {
  cfg: Config
  patch: Patch
}

export type SectionId =
  | 'general'
  | 'voice'
  | 'accessibility'
  | 'look'
  | 'models'
  | 'memory'
  | 'lessons'
  | 'privacy'
  | 'about'

export interface SectionMeta {
  id: SectionId
  label: string
  icon: IconComponent
  keywords: string
}

export const SECTIONS: readonly SectionMeta[] = [
  {
    id: 'general',
    label: 'General',
    icon: icons.settings,
    keywords: 'hotkey shortcut push to talk tap hands-free history status bubble guide highlights'
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: icons.mic,
    keywords:
      'wake word phrase hey lumen sensitivity microphone mic device test level hold tap activation vocabulary words cancel stop silence pause speech read aloud tts voice'
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    icon: icons.accessibility,
    keywords:
      'scale size text zoom motion animation contrast timings auto-close dwell click narrate confidence'
  },
  {
    id: 'look',
    label: 'Buddy & look',
    icon: icons.palette,
    keywords: 'theme dark light high contrast colour color accent custom buddy cursor appearance'
  },
  {
    id: 'models',
    label: 'Models & keys',
    icon: icons.cpu,
    keywords: 'model provider anthropic openai claude gpt api key planning verify'
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: icons.brain,
    keywords: 'memory remember learn private forget retention profile'
  },
  {
    id: 'lessons',
    label: 'Lessons',
    icon: icons.book,
    keywords: 'lessons guides library saved replay learn teach tutorial show me how'
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: icons.shield,
    keywords: 'privacy screenshots telemetry data sent logs'
  },
  { id: 'about', label: 'About', icon: icons.info, keywords: 'about version licence license help' }
]

export function isSectionId(v: string): v is SectionId {
  return SECTIONS.some((s) => s.id === v)
}

/** Sections whose label or keywords contain every word of the query. */
export function filterSections(query: string): SectionMeta[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...SECTIONS]
  return SECTIONS.filter((s) => {
    const hay = `${s.label} ${s.keywords}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
