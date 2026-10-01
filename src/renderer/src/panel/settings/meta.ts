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
  | 'skills'
  | 'background'
  | 'helpers'
  | 'bridges'
  | 'claude-code'
  | 'connectors'
  | 'privacy'
  | 'about'

export interface SectionMeta {
  id: SectionId
  label: string
  icon: IconComponent
  keywords: string
  /** Shown in simple mode (a11y.simpleMode); search still finds every section. */
  essential?: boolean
}

export const SECTIONS: readonly SectionMeta[] = [
  {
    id: 'general',
    label: 'General',
    icon: icons.settings,
    keywords: 'hotkey shortcut push to talk tap hands-free history guide highlights focus',
    essential: true
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: icons.mic,
    keywords:
      'wake word phrase hey lumen sensitivity microphone mic device test level hold tap activation vocabulary words cancel stop silence pause speech read aloud tts voice',
    essential: true
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    icon: icons.accessibility,
    keywords:
      'scale size text zoom motion animation contrast timings auto-close dwell click narrate confidence switch scanning shortcuts keyboard captions deaf hearing screen reader announce i heard confirm focus simple mode plain eye gaze tracker tobii eye control head pointer tracking',
    essential: true
  },
  {
    id: 'look',
    label: 'Buddy & look',
    icon: icons.palette,
    keywords: 'theme dark light high contrast colour color accent custom buddy cursor appearance',
    essential: true
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
    id: 'skills',
    label: 'Skills',
    icon: icons.sparkles,
    keywords:
      'skills abilities automations install share export import lumen file community trust permissions triggers'
  },
  {
    id: 'background',
    label: 'Background & routines',
    icon: icons.repeat,
    keywords:
      'background tasks routines schedule every day weekday limits cost calls quiet mode do not disturb proactive reminders when i open'
  },
  {
    id: 'helpers',
    label: 'Smart helpers',
    icon: icons.sparkles,
    keywords:
      'focus mode dim declutter undo shortcut coach tips comfort fatigue tired break error rescue what changed did it work reading level plain expert journal learned'
  },
  {
    id: 'bridges',
    label: 'App helpers',
    icon: icons.toggle,
    keywords: 'app helpers bridges blender obs add-on addon websocket password lesson checks'
  },
  {
    id: 'connectors',
    label: 'Connectors',
    icon: icons.external,
    keywords: 'connectors mcp servers tools calendar email files folder integrations agent token'
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    icon: icons.cpu,
    keywords:
      'claude code cli copilot coding agent autopilot projects permissions approve hooks terminal sessions commands'
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: icons.shield,
    keywords: 'privacy screenshots telemetry data sent logs'
  },
  {
    id: 'about',
    label: 'About',
    icon: icons.info,
    keywords: 'about version licence license help',
    essential: true
  }
]

export function isSectionId(v: string): v is SectionId {
  return SECTIONS.some((s) => s.id === v)
}

/**
 * Sections whose label or keywords contain every word of the query. Without a query, simple
 * mode (`essentials`) lists only the essential sections.
 */
export function filterSections(query: string, essentials = false): SectionMeta[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return SECTIONS.filter((s) => !essentials || s.essential)
  return SECTIONS.filter((s) => {
    const hay = `${s.label} ${s.keywords}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
