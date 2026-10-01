// After cleanup: format for the field (T35), then the app's style (T36). Pure.
import type { AppConfig } from '../../config'
import type { CleanupResult } from './cleanup'
import { fieldKindOf, formatDictation } from './format'
import { appKindOf, applyStyle, styleFor } from './styles'
import type { FocusTarget } from './terminal-guard'

type DictationConfig = AppConfig['dictation']

export interface Shaped {
  text: string
  style: string
  /** Chat apps send on Enter: line breaks go in as Shift+Enter. */
  softBreaks: boolean
}

export function shapeDictation(
  cleaned: CleanupResult,
  target: FocusTarget,
  cfg: Pick<DictationConfig, 'format' | 'styles' | 'styleApps' | 'dictionary'>
): Shaped {
  let text = cleaned.text
  if (cfg.format !== false)
    text = formatDictation(text, {
      kind: fieldKindOf(target),
      spokenCommands: cleaned.source !== 'model'
    })
  const kind = appKindOf(target, cfg.styleApps)
  const style = styleFor(kind, cfg.styles)
  text = applyStyle(text, style, { valueTail: target.valueTail, keepCase: cfg.dictionary })
  return { text, style, softBreaks: kind === 'work' || kind === 'personal' }
}
