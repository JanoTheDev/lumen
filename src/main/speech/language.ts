// The voice language as the answer prompt needs it. English adds nothing (the model already
// answers in the language it is asked in). With "auto", the language cloud Whisper detected
// in the last utterance (04 T43) is used while it is fresh.
const NAMES: Record<string, string> = {
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch'
}

/** Whisper reports the detected language by name ("german"); some builds give the code. */
const CODES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  castilian: 'es',
  german: 'de',
  french: 'fr',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  flemish: 'nl'
}

/** A detected language is trusted for the reply this long after the utterance. */
export const DETECTED_FRESH_MS = 2 * 60_000

let detected: { lang: string; at: number } | null = null

/** "German" / "de" / "de-DE" → "de"; other languages keep their lower-case name or code. */
export function languageCode(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim().toLowerCase()
  if (!t) return undefined
  if (CODES[t]) return CODES[t]
  return t.split(/[-_]/)[0]
}

/** The language detected in the utterance just transcribed (cloud, voice language auto). */
export function noteDetectedLanguage(raw: string | undefined, now = Date.now()): void {
  const lang = languageCode(raw)
  detected = lang ? { lang, at: now } : null
}

export function detectedLanguage(now = Date.now()): string | undefined {
  return detected && now - detected.at <= DETECTED_FRESH_MS ? detected.lang : undefined
}

/** The configured language, or for "auto" the last detected one ("auto" when none is known). */
export function effectiveLanguage(lang: string | undefined, now = Date.now()): string {
  const l = (lang ?? 'en').toLowerCase()
  return l === 'auto' ? (detectedLanguage(now) ?? 'auto') : l
}

/** One prompt line, or '' for English / auto without a detected language. */
export function replyLanguageLine(lang: string | undefined, now = Date.now()): string {
  const name = NAMES[effectiveLanguage(lang, now).split('-')[0]]
  return name
    ? `The user speaks ${name}. Write "text" and "spoken" in ${name}, unless they ask for another language.`
    : ''
}
