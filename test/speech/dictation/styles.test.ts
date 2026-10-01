import { describe, expect, it } from 'vitest'
import {
  applyStyle,
  appKindOf,
  isCodeEditorTarget,
  softBreaksFor,
  styleFor
} from '../../../src/main/speech/dictation/styles'
import { wordsPreserved } from '../../../src/main/speech/dictation/cleanup'

const target = (
  process: string,
  title = '',
  name = ''
): { process: string; title: string; name: string } => ({
  process,
  title,
  name
})

describe('appKindOf', () => {
  it('maps processes and tab titles to a kind', () => {
    expect(appKindOf(target('outlook.exe'))).toBe('email')
    expect(appKindOf(target('slack.exe'))).toBe('work')
    expect(appKindOf(target('whatsapp.exe'))).toBe('personal')
    expect(appKindOf(target('code.exe'))).toBe('code')
    expect(appKindOf(target('windowsterminal.exe'))).toBe('code')
    expect(appKindOf(target('chrome.exe', 'Inbox (3) - Gmail'))).toBe('email')
    expect(appKindOf(target('msedge.exe', 'WhatsApp'))).toBe('personal')
    expect(appKindOf(target('foo.exe', 'Untitled'))).toBe('other')
  })

  it('lets the user put an app or site in a kind', () => {
    expect(appKindOf(target('foo.exe'), { foo: 'work' })).toBe('work')
    expect(appKindOf(target('chrome.exe', 'Basecamp - Chat'), { basecamp: 'work' })).toBe('work')
    expect(appKindOf(target('slack.exe'), { 'slack.exe': 'personal' })).toBe('personal')
  })
})

describe('isCodeEditorTarget (M8)', () => {
  it('counts editors and terminals by process, never a browser tab by title', () => {
    expect(isCodeEditorTarget(target('code.exe'))).toBe(true)
    expect(isCodeEditorTarget(target('windowsterminal.exe'))).toBe(true)
    expect(isCodeEditorTarget(target('chrome.exe', 'Pull request #3 · GitHub'))).toBe(false)
    expect(isCodeEditorTarget(target('githubdesktop.exe', 'GitHub Desktop'))).toBe(false)
    expect(isCodeEditorTarget(target('', 'replit'))).toBe(false)
    expect(isCodeEditorTarget(target('chrome.exe', 'my ide'), { 'my ide': 'code' })).toBe(false)
    expect(isCodeEditorTarget(target('myide.exe'), { myide: 'code' })).toBe(true)
    expect(isCodeEditorTarget(target('code.exe'), { code: 'docs' })).toBe(false)
  })
})

describe('softBreaksFor (M5)', () => {
  it('types Enter only where it is a plain new line', () => {
    expect(softBreaksFor('other')).toBe(true)
    expect(softBreaksFor('work')).toBe(true)
    expect(softBreaksFor('personal')).toBe(true)
    expect(softBreaksFor('docs')).toBe(false)
    expect(softBreaksFor('email')).toBe(false)
    expect(softBreaksFor('code')).toBe(false)
  })
})

describe('styleFor', () => {
  it('uses defaults for kinds the user did not set', () => {
    expect(styleFor('email')).toBe('formal')
    expect(styleFor('code')).toBe('code')
    expect(styleFor('work', { work: 'very-casual' })).toBe('very-casual')
  })
})

describe('applyStyle', () => {
  it.each([
    ['formal', 'Thanks for the update', 'Thanks for the update.'],
    ['casual', 'Sounds good.', 'Sounds good'],
    ['casual', 'Sounds good. See you soon.', 'Sounds good. See you soon.'],
    ['casual', 'Really?', 'Really?'],
    [
      'very-casual',
      'Sounds good. See you at NASA, I think.',
      'sounds good. see you at NASA, I think'
    ],
    ['very-casual', 'I will be there.', 'I will be there'],
    ['code', 'Rename the variable.', 'rename the variable'],
    ['off', 'Hello there.', 'Hello there.']
  ] as const)('%s: %s', (style, input, want) => {
    const out = applyStyle(input, style)
    expect(out).toBe(want)
    expect(wordsPreserved(input, out)).toBe(true)
  })

  it('starts lowercase when joining an unfinished sentence', () => {
    expect(applyStyle('Then we go.', 'formal', { valueTail: 'and ' })).toBe('then we go.')
    expect(applyStyle('Then we go.', 'formal', { valueTail: 'Done. ' })).toBe('Then we go.')
  })

  it('keeps dictionary words capitalised', () => {
    expect(applyStyle('Figma is open.', 'very-casual', { keepCase: ['Figma'] })).toBe(
      'Figma is open'
    )
  })
})
