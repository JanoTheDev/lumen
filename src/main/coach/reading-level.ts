// Reading level + explanation depth (11 T21), pure. One prompt line per level for answers,
// lessons and error rescue; the AI prompt assembly (05) appends readingLevelLine() to the turn.
import type { HelpersConfig, ReadingLevel } from '@shared/config'

const LINES: Record<ReadingLevel, string> = {
  plain:
    'Reading level: plain. Use short sentences and everyday words, one idea per sentence, no jargon (explain any technical word you must use), and give the single next step first.',
  standard: '',
  expert:
    'Reading level: expert. Be concise and technical: use the proper terms, skip basics, and mention the shortcut or setting name directly.'
}

/** The level for an app (per-app override first), or the global one. */
export function readingLevelFor(
  cfg: Pick<HelpersConfig, 'readingLevel' | 'readingLevelApps'>,
  appId?: string | null
): ReadingLevel {
  return (appId && cfg.readingLevelApps[appId]) || cfg.readingLevel
}

/** The prompt modifier line; '' for standard (the default prompt is already standard). */
export function readingLevelLine(level: ReadingLevel): string {
  return LINES[level]
}

const ORDER: ReadingLevel[] = ['plain', 'standard', 'expert']

/** "simpler" moves one step towards plain, "more detail" one towards expert. */
export function stepLevel(level: ReadingLevel, dir: 'simpler' | 'deeper'): ReadingLevel {
  const i = ORDER.indexOf(level) + (dir === 'simpler' ? -1 : 1)
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, i))]
}

export function levelName(level: ReadingLevel): string {
  return level === 'plain' ? 'plain and simple' : level === 'expert' ? 'expert' : 'standard'
}

/** Config patch that sets `level` globally or for one app. */
export function readingLevelPatch(
  cfg: Pick<HelpersConfig, 'readingLevelApps'>,
  level: ReadingLevel,
  appId?: string | null
): Partial<HelpersConfig> {
  if (!appId) return { readingLevel: level }
  return { readingLevelApps: { ...cfg.readingLevelApps, [appId]: level } }
}
