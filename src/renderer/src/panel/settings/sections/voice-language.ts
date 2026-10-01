import type { VoiceLanguage } from '@shared/config'

export const LANGUAGE_OPTIONS: Array<{ value: VoiceLanguage; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español (Spanish)' },
  { value: 'de', label: 'Deutsch (German)' },
  { value: 'fr', label: 'Français (French)' },
  { value: 'it', label: 'Italiano (Italian)' },
  { value: 'pt', label: 'Português (Portuguese)' },
  { value: 'nl', label: 'Nederlands (Dutch)' },
  { value: 'auto', label: 'Detect (OpenAI only)' }
]

const OFFLINE = new Set<VoiceLanguage>(['en', 'es', 'de', 'fr'])

export function languageHint(lang: VoiceLanguage): string {
  if (lang === 'auto')
    return 'OpenAI detects the language. Offline recognition then listens for English.'
  const answers = 'Answers and spoken replies follow this language.'
  if (lang === 'en') return answers
  if (OFFLINE.has(lang))
    return `${answers} Offline recognition needs a second free model (154 MB), downloaded when you pick it.`
  return `${answers} This language needs an OpenAI key for speech recognition.`
}

/** "Figma, GitHub\nDaVinci" → ["Figma", "GitHub", "DaVinci"], no duplicates or blanks. */
export function dictionaryFromText(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[,\n]/)) {
    const w = raw.trim().slice(0, 60)
    if (!w || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out.slice(0, 500)
}
