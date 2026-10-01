import { describe, it, expect } from 'vitest'
import {
  parseGuideNav,
  isReplayRequest,
  matchSaveGuide,
  matchPlayGuide,
  normalizeUtterance
} from '../src/main/guides/voice-nav'

describe('parseGuideNav', () => {
  it.each([
    ['next', 'next'],
    ['Next.', 'next'],
    ['next step', 'next'],
    ['Okay, next step please', 'next'],
    ['Lumen, next!', 'next'],
    ['continue', 'next'],
    ['go on', 'next'],
    ['back', 'prev'],
    ['Go back.', 'prev'],
    ['previous', 'prev'],
    ['previous step please', 'prev'],
    ['repeat', 'repeat'],
    ['say again', 'repeat'],
    ['Say that again?', 'repeat'],
    ['What was that?', 'repeat'],
    ['done', 'done'],
    ['Finished!', 'done'],
    ['finish', 'done'],
    ['close the guide', 'done'],
    ['close guide', 'done'],
    ['exit guide', 'done'],
    ["what's the weather", null],
    ['go back to gmail', null],
    ['next episode on netflix', null],
    ['continue writing this email', null],
    ['what is this', null],
    ['what', null],
    ['again', null],
    ['stop', null],
    ['cancel my subscription', null],
    ['close the tab', null],
    ['how do I open settings', null],
    ['done with the report, send it', null],
    ['repeat the last email to john', null],
    ['open the back office page', null],
    ['', null],
    ['   ', null]
  ] as const)('%j -> %s', (utterance, expected) => {
    expect(parseGuideNav(utterance)).toBe(expected)
  })
})

describe('normalizeUtterance', () => {
  it('lowercases, strips punctuation and filler', () => {
    expect(normalizeUtterance('Hey Lumen, OK... NEXT step, please!')).toBe('next step')
    expect(normalizeUtterance("What's up")).toBe('whats up')
  })
})

describe('isReplayRequest', () => {
  it.each([
    ['replay the guide', true],
    ['replay last guide', true],
    ['show me the guide again', true],
    ['open the last guide', true],
    ['do the guide again', true],
    ['restart guide', true],
    ['replay', false],
    ['one more time', false],
    ['replay that video', false],
    ['show me the last email', false],
    ['do that again', false],
    ['what was the last guide about', false],
    ['how do I replay the guide', false]
  ] as const)('%j -> %s', (text, expected) => {
    expect(isReplayRequest(text)).toBe(expected)
  })
})

describe('matchSaveGuide', () => {
  it('matches with and without a name', () => {
    expect(matchSaveGuide('save this guide')).toEqual({})
    expect(matchSaveGuide('Remember the guide as Gmail filters.')).toEqual({
      name: 'Gmail filters'
    })
    expect(matchSaveGuide('save guide as inbox zero')).toEqual({ name: 'inbox zero' })
    expect(matchSaveGuide('save this document')).toBeNull()
    expect(matchSaveGuide('what is a guide')).toBeNull()
    expect(matchSaveGuide('can you save this guide somewhere')).toBeNull()
    expect(matchSaveGuide('save this guide.')).toEqual({})
  })
})

describe('matchPlayGuide', () => {
  it('extracts the guide name', () => {
    expect(matchPlayGuide('play guide gmail filters')).toBe('gmail filters')
    expect(matchPlayGuide('Run the guide called Inbox Zero.')).toBe('Inbox Zero')
    expect(matchPlayGuide('open saved guide named billing')).toBe('billing')
    expect(matchPlayGuide('play guide')).toBeNull()
    expect(matchPlayGuide('play guide again')).toBeNull()
    expect(matchPlayGuide('play some music')).toBeNull()
    expect(matchPlayGuide('how do I open the guide editor')).toBeNull()
  })
})
