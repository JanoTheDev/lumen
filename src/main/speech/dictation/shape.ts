// After cleanup: names (T39 app terms, T41 screen names), format for the field (T35), the
// app's style (T36), then coding mode in code editors and terminals (T42). Pure.
import type { AppConfig } from '../../config'
import { applyDictionary, type CleanupResult } from './cleanup'
import { applyCodingMode, type FileResolver } from './coding'
import { fieldKindOf, formatDictation } from './format'
import { respellFromScreen } from './names'
import { appKindOf, applyStyle, isCodeEditorTarget, softBreaksFor, styleFor } from './styles'
import type { FocusTarget } from './terminal-guard'

type DictationConfig = AppConfig['dictation']

export interface Shaped {
  text: string
  style: string
  /** Line breaks go in as Shift+Enter (chat and unknown apps, where Enter may send). */
  softBreaks: boolean
}

export interface ShapeExtras {
  /** Dictionary terms of the focused app (T39). */
  appTerms?: readonly string[]
  /** Names read from the focused window (T41). */
  screenNames?: readonly string[]
  /** Spoken file names → project paths for "at file …" (T42). */
  resolveFile?: FileResolver
}

export function shapeDictation(
  cleaned: CleanupResult,
  target: FocusTarget,
  cfg: Pick<DictationConfig, 'format' | 'styles' | 'styleApps' | 'dictionary'> &
    Partial<Pick<DictationConfig, 'codingMode'>>,
  extras: ShapeExtras = {}
): Shaped {
  let text = cleaned.text
  const appTerms = extras.appTerms ?? []
  if (appTerms.length) text = applyDictionary(text, appTerms)
  if (extras.screenNames?.length) text = respellFromScreen(text, extras.screenNames)
  if (cfg.format !== false)
    text = formatDictation(text, {
      kind: fieldKindOf(target),
      spokenCommands: cleaned.source !== 'model'
    })
  const kind = appKindOf(target, cfg.styleApps)
  const style = styleFor(kind, cfg.styles)
  text = applyStyle(text, style, {
    valueTail: target.valueTail,
    // Names on screen keep their capital mid-sentence too ("I met" + "John") (L4).
    keepCase: [...cfg.dictionary, ...appTerms, ...(extras.screenNames ?? [])]
  })
  // Spoken symbols only in real editors and terminals, never a browser tab by its title (M8).
  if (cfg.codingMode !== false && isCodeEditorTarget(target, cfg.styleApps))
    text = applyCodingMode(text, { resolveFile: extras.resolveFile })
  return { text, style, softBreaks: softBreaksFor(kind) }
}
