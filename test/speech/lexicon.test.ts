import { describe, expect, it } from 'vitest'
import {
  canonicalUtterance,
  foldText,
  LEXICON_LANGS,
  lexiconLangs,
  matchConfirm,
  matchWord,
  phrases
} from '../../src/main/speech/lexicon'
import { prepareVoiceText, type HookDeps } from '../../src/main/speech/router-hook'

describe('lexicon', () => {
  it('folds accents, case and punctuation', () => {
    expect(foldText('¡Sí!')).toBe('si')
    expect(foldText('  Nein,  danke. ')).toBe('nein danke')
  })

  it('ships yes/no/stop for every language', () => {
    expect(LEXICON_LANGS).toEqual(expect.arrayContaining(['en', 'es', 'de']))
    for (const l of LEXICON_LANGS)
      for (const w of ['yes', 'no', 'stop', 'always'] as const)
        expect(phrases(l, w).length).toBeGreaterThan(0)
  })

  it.each([
    ['en', 'yes', 'yes'],
    ['en', 'Okay.', 'yes'],
    ['en', 'no thanks', 'no'],
    ['en', 'cancel', 'no'],
    ['en', 'always allow', 'always'],
    ['es', 'Sí', 'yes'],
    ['es', 'vale', 'yes'],
    ['es', 'no', 'no'],
    ['es', 'para', 'no'],
    ['es', 'sí siempre', 'always'],
    ['de', 'ja bitte', 'yes'],
    ['de', 'nein', 'no'],
    ['de', 'stopp', 'no'],
    ['de', 'immer', 'always'],
    ['fr', 'oui', 'yes'],
    ['it', 'sì', 'yes'],
    ['pt', 'não', 'no'],
    ['nl', 'nee', 'no']
  ])('%s: %j → %s', (lang, text, want) => {
    expect(matchConfirm(text, lang)).toBe(want)
  })

  it('needs the whole utterance', () => {
    expect(matchConfirm('yes open mail', 'en')).toBeNull()
    expect(matchConfirm('sí abre el correo', 'es')).toBeNull()
    expect(matchConfirm('no, I said open mail', 'en')).toBeNull()
  })

  it('drops politeness at the edges', () => {
    expect(matchConfirm('yes, thanks', 'en')).toBe('yes')
    expect(matchConfirm('sí, gracias', 'es')).toBe('yes')
    expect(matchConfirm('ja, danke', 'de')).toBe('yes')
  })

  it('English utterances only see the English table', () => {
    expect(lexiconLangs('en')).toEqual(['en'])
    expect(lexiconLangs('es-MX')).toEqual(['es', 'en'])
    expect(lexiconLangs('xx')).toEqual(['en'])
    expect(matchWord('ja', 'en')).toBeNull()
    expect(matchWord('ja', 'auto')).toBe('yes')
  })

  it('rewrites other languages to the English word', () => {
    expect(canonicalUtterance('Sí', 'es')).toBe('yes')
    expect(canonicalUtterance('siguiente', 'es')).toBe('next')
    expect(canonicalUtterance('abbrechen', 'de')).toBe('stop')
    expect(canonicalUtterance('no', 'es')).toBe('no')
    expect(canonicalUtterance('abre el correo', 'es')).toBe('abre el correo')
    expect(canonicalUtterance('sí', 'en')).toBe('sí')
  })
})

describe('prepareVoiceText', () => {
  const deps = (
    busy: boolean,
    lang: ReturnType<HookDeps['lang']> = 'en'
  ): { d: HookDeps; calls: string[] } => {
    const calls: string[] = []
    const d: HookDeps = { lang: () => lang, busy: () => busy, cancel: () => !!calls.push('cancel') }
    return { d, calls }
  }

  it('cancels a running action on "stop, …" and keeps the request', () => {
    const { d, calls } = deps(true)
    expect(prepareVoiceText('stop, open notepad', d)).toBe('open notepad')
    expect(calls).toEqual(['cancel'])
  })

  it('leaves it alone while nothing runs', () => {
    const { d, calls } = deps(false)
    expect(prepareVoiceText('stop, open notepad', d)).toBe('stop, open notepad')
    expect(calls).toEqual([])
  })

  it('maps short answers in the voice language', () => {
    expect(prepareVoiceText('sí', deps(false, 'es').d)).toBe('yes')
    expect(prepareVoiceText('Para.', deps(true, 'es').d)).toBe('stop')
  })
})

describe('replyLanguageLine', () => {
  it('names the language for the answer prompt', async () => {
    const { replyLanguageLine } = await import('../../src/main/speech/language')
    expect(replyLanguageLine('es')).toContain('Spanish')
    expect(replyLanguageLine('en')).toBe('')
    expect(replyLanguageLine('auto')).toBe('')
  })
})
