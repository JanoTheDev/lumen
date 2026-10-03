import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { normalizeSettings, parseSettingsCommand as p } from '../../src/main/voice-settings/grammar'
import { SETTINGS } from '../../src/main/voice-settings/table'
import { undoSentence } from '../../src/main/voice-settings/run'

const set = (id: string, op: unknown): unknown => ({ kind: 'set', id, op })

describe('normalize', () => {
  it('drops accents, punctuation, address and politeness; notes Lumen words', () => {
    expect(normalizeSettings('Hey Lumen, habla inglés, please!')).toEqual({
      text: 'habla ingles',
      scoped: false
    })
    expect(normalizeSettings('Turn on dark mode in Lumen.')).toEqual({
      text: 'turn on dark mode',
      scoped: true
    })
    expect(normalizeSettings("Make Lumen's text bigger")).toEqual({
      text: 'make text bigger',
      scoped: true
    })
    expect(normalizeSettings('Set your text size to 150%').text).toBe(
      'set your text size to 150 percent'
    )
  })
})

describe('spoken replies, speed, voice', () => {
  it('turns spoken replies on and off', () => {
    for (const s of [
      'talk to me',
      'Read answers aloud',
      'read your answers out loud',
      'speak your answers',
      'unmute your voice'
    ])
      expect(p(s), s).toEqual(set('spoken-replies', { to: true }))
    for (const s of ['turn on voice replies', 'spoken replies on', 'turn your voice on'])
      expect(p(s), s).toEqual(set('spoken-replies', { on: true }))
    for (const s of ['mute your voice', "don't read answers aloud", 'stop reading your answers'])
      expect(p(s), s).toEqual(set('spoken-replies', { to: false }))
    expect(p('turn off spoken replies')).toEqual(set('spoken-replies', { on: false }))
  })

  it('speaking speed', () => {
    expect(p('speak slower')).toEqual(set('speech-rate', { step: -1 }))
    expect(p('talk a bit faster')).toEqual(set('speech-rate', { step: 1 }))
    expect(p('speak more slowly')).toEqual(set('speech-rate', { step: -1 }))
    expect(p('speak at normal speed')).toEqual(set('speech-rate', { reset: true }))
    expect(p('set your speaking speed to 1.5')).toEqual(
      set('speech-rate', { number: 1.5, percent: false })
    )
  })

  it('voices', () => {
    expect(p('use the voice Zira')).toEqual({ kind: 'voice', name: 'zira', explicit: false })
    expect(p('use the David voice')).toEqual({ kind: 'voice', name: 'david', explicit: false })
    expect(p('change your voice to Mark')).toEqual({ kind: 'voice', name: 'mark', explicit: true })
    expect(p('use a female voice')).toEqual({ kind: 'voice', name: 'female', explicit: true })
    expect(p('use a different voice')).toEqual({ kind: 'voice', name: 'next', explicit: true })
    expect(p('what voice is this')).toEqual({ kind: 'voice-query' })
    expect(p('what voices do you have')).toEqual({ kind: 'voice-list' })
    // Windows' own voice features.
    expect(p('use voice typing')).toBeNull()
    expect(p('use voice access')).toBeNull()
  })
})

describe('language', () => {
  it('English sentences', () => {
    expect(p('speak Spanish')).toEqual(set('language', { to: 'es' }))
    expect(p('talk to me in German')).toEqual(set('language', { to: 'de' }))
    expect(p('switch to German')).toEqual(set('language', { to: 'de' }))
    expect(p('reply to me in French')).toEqual(set('language', { to: 'fr' }))
    expect(p('use English')).toEqual(set('language', { to: 'en' }))
    expect(p('set your language to Dutch')).toEqual(set('language', { to: 'nl' }))
    expect(p('detect my language')).toEqual(set('language', { to: 'auto' }))
    expect(p('what language are you speaking')).toEqual({ kind: 'query', id: 'language' })
  })

  it('back to English in the voice languages', () => {
    expect(p('Habla inglés')).toEqual(set('language', { to: 'en' }))
    expect(p('en inglés')).toEqual(set('language', { to: 'en' }))
    expect(p('Sprich Englisch')).toEqual(set('language', { to: 'en' }))
    expect(p('auf Englisch')).toEqual(set('language', { to: 'en' }))
    expect(p('Parle anglais')).toEqual(set('language', { to: 'en' }))
    expect(p('rispondi in inglese')).toEqual(set('language', { to: 'en' }))
    expect(p('fala português')).toEqual(set('language', { to: 'pt' }))
    expect(p('spreek Engels')).toEqual(set('language', { to: 'en' }))
  })

  it('leaves translations and email replies to the model', () => {
    expect(p('reply in French')).toBeNull()
    expect(p('in German')).toBeNull()
    expect(p('say it in Spanish')).toBeNull()
    expect(p('translate this to Spanish')).toBeNull()
    expect(p('switch to Chrome')).toBeNull()
  })
})

describe('seeing', () => {
  it('text size needs Lumen in the words', () => {
    expect(p('make your text bigger')).toEqual(set('text-size', { step: 1 }))
    expect(p('make Lumen text smaller')).toEqual(set('text-size', { step: -1 }))
    expect(p('bigger text in Lumen')).toEqual(set('text-size', { step: 1 }))
    expect(p('reset your text size')).toEqual(set('text-size', { reset: true }))
    expect(p('set your text size to 150 percent')).toEqual(
      set('text-size', { number: 150, percent: true })
    )
    expect(p('make the text bigger')).toBeNull()
    expect(p('bigger text')).toBeNull()
    expect(p('reset text size')).toBeNull()
  })

  it('simple mode, reduce motion, high contrast', () => {
    expect(p('turn on simple mode')).toEqual(set('simple-mode', { on: true }))
    expect(p('simple mode off')).toEqual(set('simple-mode', { on: false }))
    expect(p('turn on reduce motion')).toEqual(set('reduce-motion', { on: true }))
    expect(p('turn on high contrast in Lumen')).toEqual(set('high-contrast', { on: true }))
    expect(p('turn on high contrast')).toBeNull()
  })

  it('theme and accent need Lumen in the words', () => {
    expect(p('use the Lumen dark theme')).toEqual(set('theme', { to: 'dark' }))
    expect(p('use the high contrast theme in Lumen')).toEqual(set('theme', { to: 'high-contrast' }))
    expect(p('set your theme to ocean')).toEqual(set('theme', { to: 'ocean' }))
    expect(p('turn on dark mode in Lumen')).toEqual(set('theme', { to: 'dark' }))
    expect(p("turn off Lumen's dark mode")).toEqual(set('theme', { to: 'light' }))
    expect(p('make your accent purple')).toEqual(set('accent', { to: 'violet' }))
    expect(p('use the teal accent in Lumen')).toEqual(set('accent', { to: 'teal' }))
    expect(p('turn on dark mode')).toBeNull()
    expect(p('Lumen, turn on dark mode')).toBeNull()
    expect(p('use the dark theme')).toBeNull()
    expect(p('use the teal accent')).toBeNull()
  })
})

describe('hearing, thinking, moving', () => {
  it('captions', () => {
    expect(p('turn on Lumen captions')).toEqual(set('captions', { on: true }))
    expect(p('hide your captions')).toEqual(set('captions', { on: false }))
    expect(p('caption what you say')).toEqual(set('captions', { to: true }))
    expect(p('turn on captions')).toBeNull()
    expect(p('turn on subtitles')).toBeNull()
  })

  it('narration, updates, explain, confidence', () => {
    expect(p('read what I focus on')).toEqual(set('focus-narration', { to: true }))
    expect(p('turn off focus narration')).toEqual(set('focus-narration', { on: false }))
    expect(p('turn off spoken updates')).toEqual(set('announce', { on: false }))
    expect(p('turn off announcements')).toBeNull()
    expect(p('turn off Lumen announcements')).toEqual(set('announce', { on: false }))
    expect(p('explain before you do anything')).toEqual(set('explain-before', { to: true }))
    expect(p('show me how sure you are')).toEqual(set('confidence', { to: true }))
    expect(p('hide confidence scores')).toEqual(set('confidence', { on: false }))
    expect(p('always ask before doing things')).toEqual(set('agent-confirm', { to: 'always' }))
    expect(p('stop asking for permission')).toEqual(set('agent-confirm', { to: 'never' }))
  })

  it('dwell, switch, face; bare dwell stays with the a11y grammar', () => {
    expect(p('turn on dwell clicking')).toEqual(set('dwell-click', { on: true }))
    expect(p('stop dwell clicking')).toEqual(set('dwell-click', { on: false }))
    expect(p('turn on switch access')).toEqual(set('switch-access', { on: true }))
    expect(p('face gestures off')).toEqual(set('face-gestures', { on: false }))
    expect(p('turn off dwell')).toBeNull()
    expect(p('pause dwell')).toBeNull()
    expect(p('start scanning')).toBeNull()
    expect(p('head pointer on')).toBeNull()
  })

  it('voice input', () => {
    expect(p('turn on the wake word')).toEqual(set('wake-word', { on: true }))
    expect(p('make the wake word more sensitive')).toEqual(set('wake-sensitivity', { step: 1 }))
    expect(p('turn off conversation mode')).toEqual(set('conversation', { on: false }))
    expect(p('use tap to talk')).toEqual(set('talk-mode', { to: true }))
    expect(p('hold to talk')).toEqual(set('talk-mode', { to: false }))
  })
})

describe('helpers, buddy, memory, dictation, system', () => {
  it('toggles', () => {
    expect(p('turn on pointing')).toEqual(set('pointing', { on: true }))
    expect(p('turn off the learning journal')).toEqual(set('journal', { on: false }))
    expect(p('enable error rescue')).toEqual(set('error-rescue', { on: true }))
    expect(p('hide the buddy')).toEqual(set('buddy', { on: false }))
    expect(p('show the buddy')).toEqual(set('buddy', { on: true }))
    expect(p('make the buddy follow my pointer')).toEqual(set('buddy-follow', { to: true }))
    expect(p('turn on memory')).toEqual(set('memory', { on: true }))
    expect(p('ask before learning about me')).toEqual(set('auto-learn', { to: 'ask' }))
    expect(p('turn off dictation sounds')).toEqual(set('dictation-sounds', { on: false }))
    expect(p('lower the volume while I dictate')).toEqual(set('duck-media', { to: true }))
    expect(p('start Lumen with Windows')).toEqual(set('start-at-login', { to: true }))
    expect(p("don't start at login")).toEqual(set('start-at-login', { to: false }))
    expect(p('turn off Lumen automatic updates')).toEqual(set('auto-update', { on: false }))
    expect(p('turn on local only')).toEqual(set('local-only', { on: true }))
    expect(p('use the cloud again')).toEqual(set('local-only', { to: false }))
  })

  it('leaves other owners alone', () => {
    expect(p('turn off inbox buddy')).toBeNull()
    expect(p('private mode on')).toBeNull()
    expect(p('stop remembering')).toBeNull()
    expect(p('turn on focus mode')).toBeNull()
    expect(p('turn off automatic updates')).toBeNull()
  })
})

describe('queries', () => {
  it('reads values back', () => {
    expect(p('is the wake word on')).toEqual({ kind: 'query', id: 'wake-word' })
    expect(p("what's your text size")).toEqual({ kind: 'query', id: 'text-size' })
    expect(p('is simple mode on')).toEqual({ kind: 'query', id: 'simple-mode' })
    expect(p('what is your theme')).toEqual({ kind: 'query', id: 'theme' })
    expect(p('what is memory')).toBeNull()
    expect(p('what is a wake word')).toBeNull()
    expect(p('is dark mode on')).toBeNull()
  })
})

describe('pages, setup, updates', () => {
  it('opens Lumen pages, never Windows ones', () => {
    expect(p('open voice settings')).toEqual({ kind: 'open', section: 'voice' })
    expect(p('show accessibility settings')).toEqual({ kind: 'open', section: 'accessibility' })
    expect(p('open Lumen settings for buddies')).toEqual({ kind: 'open', section: 'buddies' })
    expect(p('show me your privacy settings')).toEqual({ kind: 'open', section: 'privacy' })
    expect(p('open smart helpers settings')).toEqual({ kind: 'open', section: 'helpers' })
    expect(p('open Lumen settings')).toEqual({ kind: 'open', section: null })
    expect(p('open settings')).toBeNull()
    expect(p('open privacy settings')).toBeNull()
    expect(p('open display settings')).toBeNull()
    expect(p('open bluetooth settings')).toBeNull()
    expect(p('open windows accessibility settings')).toBeNull()
    expect(p('open microphone settings')).toBeNull()
  })

  it('setup again', () => {
    expect(p('start setup again')).toEqual({ kind: 'onboarding' })
    expect(p('show me around')).toEqual({ kind: 'onboarding' })
    expect(p('show me around Photoshop')).toBeNull()
  })

  it('updates', () => {
    expect(p('check for Lumen updates')).toEqual({ kind: 'update-check' })
    expect(p('update yourself')).toEqual({ kind: 'update-check' })
    expect(p('are you up to date')).toEqual({ kind: 'update-check' })
    expect(p('check for updates')).toBeNull()
    expect(p('restart to update')).toEqual({ kind: 'update-install', scoped: false })
  })
})

describe('questions for the model never match', () => {
  it.each([
    'how do I turn on dark mode in Word',
    'turn on dark mode in Word',
    'how do I make the text bigger in Word',
    'make the text bigger',
    'turn on captions in YouTube',
    'what is dwell clicking',
    'talk to me about my day',
    'speak to me about history',
    'can you read this page aloud',
    'read this',
    'stop',
    'stop talking',
    'be quiet',
    'open notepad',
    'what can I say',
    'turn on the lights',
    'turn on wifi',
    'zoom in',
    'make it bigger',
    'use the dark theme in VS Code',
    'switch to the next tab',
    'change the language of this document to German'
  ])('%s', (s) => {
    expect(p(s)).toBeNull()
  })
})

describe('table', () => {
  it('every undo sentence parses back to the opposite change', () => {
    for (const row of SETTINGS) {
      if (row.kind === 'number') {
        expect(p(row.sayMore), row.sayMore).toMatchObject({ id: row.id, op: { step: 1 } })
        expect(p(row.sayLess), row.sayLess).toMatchObject({ id: row.id, op: { step: -1 } })
        expect(p(row.sayReset), row.sayReset).toMatchObject({ id: row.id, op: { reset: true } })
        continue
      }
      if (row.kind === 'enum' && row.onValue === undefined) continue
      expect(p(undoSentence(row, true)), row.id).toEqual(set(row.id, { on: false }))
      expect(p(undoSentence(row, false)), row.id).toEqual(set(row.id, { on: true }))
    }
  })

  it('every help sentence parses', () => {
    for (const row of SETTINGS) if (row.help) expect(p(row.help.say), row.help.say).not.toBeNull()
  })

  it('ids are unique and section ids exist in the panel', () => {
    expect(new Set(SETTINGS.map((r) => r.id)).size).toBe(SETTINGS.length)
    const meta = readFileSync(
      join(__dirname, '../../src/renderer/src/panel/settings/meta.ts'),
      'utf8'
    )
    for (const id of ['voice', 'accessibility', 'buddies', 'helpers', 'privacy', 'background'])
      expect(meta).toContain(`| '${id}'`)
  })
})
