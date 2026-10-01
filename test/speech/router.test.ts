import { describe, expect, it } from 'vitest'
import { IDLE_CONTEXT } from '../../src/main/a11y/voice-commands'
import { leadingStop, routeUtterance, type RouteState } from '../../src/main/speech/router'

const idle: RouteState = { confirmPending: false, lessonRunning: false, busy: false }
const confirm: RouteState = { ...idle, confirmPending: true }
const lesson: RouteState = { ...idle, lessonRunning: true }
const busy: RouteState = { ...idle, busy: true }
const guide: RouteState = { ...idle, commands: { ...IDLE_CONTEXT, guideActive: true } }
const marks: RouteState = { ...idle, commands: { ...IDLE_CONTEXT, marksShown: true } }
const es = (s: RouteState): RouteState => ({ ...s, lang: 'es' })
const de = (s: RouteState): RouteState => ({ ...s, lang: 'de' })

type Row = [text: string, state: RouteState, kind: string, detail?: unknown]

const detail = (r: ReturnType<typeof routeUtterance>): unknown => {
  switch (r.kind) {
    case 'confirm':
      return r.answer
    case 'lesson':
      return r.command
    case 'local':
      return r.command.id
    case 'cancel':
      return r.rest
    case 'query':
      return r.text
    default:
      return undefined
  }
}

const ROWS: Row[] = [
  // empty
  ['', idle, 'empty'],
  ['   ', idle, 'empty'],
  ['...', idle, 'empty'],
  // a waiting confirm
  ['yes', confirm, 'confirm', 'yes'],
  ['Yes.', confirm, 'confirm', 'yes'],
  ['yeah sure', confirm, 'query'],
  ['okay', confirm, 'confirm', 'yes'],
  ['no', confirm, 'confirm', 'no'],
  ['nope', confirm, 'confirm', 'no'],
  ['stop', confirm, 'confirm', 'no'],
  ['cancel', confirm, 'confirm', 'no'],
  ['always', confirm, 'confirm', 'always'],
  ['yes please', confirm, 'confirm', 'yes'],
  ['no, I said open mail', confirm, 'query', 'no, I said open mail'],
  ['open notepad instead', confirm, 'local', 'app.open'],
  ['what time is it in Tokyo', confirm, 'query', 'what time is it in Tokyo'],
  ['sí', es(confirm), 'confirm', 'yes'],
  ['¡Sí, por favor!', es(confirm), 'confirm', 'yes'],
  ['no gracias', es(confirm), 'confirm', 'no'],
  ['siempre', es(confirm), 'confirm', 'always'],
  ['cancela', es(confirm), 'confirm', 'no'],
  ['ja', de(confirm), 'confirm', 'yes'],
  ['Nein danke', de(confirm), 'confirm', 'no'],
  ['immer erlauben', de(confirm), 'confirm', 'always'],
  ['abbrechen', de(confirm), 'confirm', 'no'],
  // yes without a confirm is not an answer
  ['sí', es(idle), 'query', 'sí'],
  // lesson words, whole utterance only
  ['next', lesson, 'lesson', 'next'],
  ['go back', lesson, 'lesson', 'back'],
  ['repeat', lesson, 'lesson', 'repeat'],
  ['go back to gmail', lesson, 'query', 'go back to gmail'],
  ['siguiente', es(lesson), 'lesson', 'next'],
  ['atrás', es(lesson), 'lesson', 'back'],
  ['weiter', de(lesson), 'lesson', 'next'],
  // 06 grammar, no word minimum
  ['scroll down', idle, 'local', 'scroll'],
  ['click 5', marks, 'local', 'marks.act'],
  ['show numbers', idle, 'local', 'marks.show'],
  ['press control c', idle, 'local', 'key.press'],
  ["what's the weather", guide, 'query', "what's the weather"],
  // cancel
  ['stop', idle, 'cancel'],
  ['never mind', idle, 'cancel'],
  ['Cancel that.', busy, 'cancel'],
  ['para', es(busy), 'cancel'],
  ['stopwatch timer', busy, 'query', 'stopwatch timer'],
  ['stop the music', busy, 'query', 'stop the music'],
  ['cancel my meeting tomorrow', busy, 'query', 'cancel my meeting tomorrow'],
  ['stop, open notepad', busy, 'cancel', 'open notepad'],
  ['Stop. Open the downloads folder', busy, 'cancel', 'Open the downloads folder'],
  ['stop, open notepad', idle, 'query', 'stop, open notepad'],
  ['para, abre el correo', es(busy), 'cancel', 'abre el correo'],
  // queries
  ['open gmail', idle, 'local', 'app.open'],
  ['summarize this page', idle, 'query', 'summarize this page'],
  ['write a polite reply to this email', idle, 'query', 'write a polite reply to this email'],
  ['¿qué tiempo hace hoy?', es(idle), 'query', '¿qué tiempo hace hoy?'],
  ['yes', idle, 'query', 'yes']
]

describe('voice router', () => {
  it('has a table of at least 40 utterances', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(40)
  })

  it.each(ROWS)('%j → %s', (text, state, kind, want) => {
    const r = routeUtterance(text, state)
    expect(r.kind).toBe(kind)
    if (want !== undefined) expect(detail(r)).toEqual(want)
  })

  it('carries the voice language to the query', () => {
    const r = routeUtterance('abre el correo', es(idle))
    expect(r).toEqual({ kind: 'query', text: 'abre el correo', lang: 'es' })
  })

  it('skips the grammar when voice commands are off', () => {
    expect(routeUtterance('scroll down', { ...idle, grammar: false }).kind).toBe('query')
  })
})

describe('leadingStop', () => {
  it.each([
    ['stop', ''],
    ['stop it', ''],
    ['cancel, open mail', 'open mail'],
    ['never mind - open mail', 'open mail']
  ])('%j → %j', (text, rest) => {
    expect(leadingStop(text)).toEqual({ rest })
  })

  it.each(['stopwatch', 'stop the music', 'open mail', 'cancellation policy'])(
    '%j is no stop',
    (text) => {
      expect(leadingStop(text)).toBeNull()
    }
  )
})
