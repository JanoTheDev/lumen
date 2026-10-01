// The voice language as the answer prompt needs it. English and auto add nothing (the model
// already answers in the language it is asked in).
const NAMES: Record<string, string> = {
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch'
}

/** One prompt line, or '' for English / auto. */
export function replyLanguageLine(lang: string | undefined): string {
  const name = NAMES[(lang ?? '').toLowerCase().split('-')[0]]
  return name
    ? `The user speaks ${name}. Write "text" and "spoken" in ${name}, unless they ask for another language.`
    : ''
}
