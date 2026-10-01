import { describe, expect, it } from 'vitest'
import {
  applyCaseCommands,
  applyCodingMode,
  applyFileTags,
  applySymbols,
  caseWords
} from '../../../src/main/speech/dictation/coding'

describe('caseWords', () => {
  it('builds each identifier style', () => {
    const w = ['user', 'Name', 'id']
    expect(caseWords(w, 'camel')).toBe('userNameId')
    expect(caseWords(w, 'pascal')).toBe('UserNameId')
    expect(caseWords(w, 'snake')).toBe('user_name_id')
    expect(caseWords(w, 'kebab')).toBe('user-name-id')
    expect(caseWords(w, 'constant')).toBe('USER_NAME_ID')
  })
})

describe('applyCaseCommands', () => {
  it('turns "x case words" into an identifier that ends at a stop word', () => {
    expect(applyCaseCommands('rename camel case user name to account id')).toBe(
      'rename userName to account id'
    )
    expect(applyCaseCommands('Snake case max retry count')).toBe('max_retry_count')
    expect(applyCaseCommands('set screaming snake case api key, then save')).toBe(
      'set API_KEY, then save'
    )
    expect(applyCaseCommands('Pascal case dictation pipeline.')).toBe('DictationPipeline.')
  })

  it('leaves text without a case command alone', () => {
    expect(applyCaseCommands('in any case we ship')).toBe('in any case we ship')
  })
})

describe('applySymbols', () => {
  it('glues brackets, dots and underscores the way code is written', () => {
    expect(applySymbols('call foo open paren bar close paren')).toBe('call foo (bar)')
    expect(applySymbols('open config dot json')).toBe('open config.json')
    expect(applySymbols('x equals y')).toBe('x = y')
    expect(applySymbols('if a triple equals b')).toBe('if a === b')
    expect(applySymbols('src slash main slash index dot ts')).toBe('src/main/index.ts')
    expect(applySymbols('my underscore var')).toBe('my_var')
  })

  it('keeps "dot" as a word at the edges', () => {
    expect(applySymbols('put a dot')).toBe('put a dot')
    expect(applySymbols('dot the i')).toBe('dot the i')
  })

  it('does nothing without symbol words', () => {
    expect(applySymbols('fix the failing test')).toBe('fix the failing test')
  })
})

describe('applyFileTags', () => {
  it('makes an @ mention, resolved when the project knows the file', () => {
    expect(applyFileTags('look at file pipeline.ts please')).toBe('look @pipeline.ts please')
    expect(
      applyFileTags('check At file pipeline.ts.', (n) =>
        n === 'pipeline.ts' ? 'src/main/pipeline.ts' : null
      )
    ).toBe('check @src/main/pipeline.ts.')
  })
})

describe('applyCodingMode', () => {
  it('runs identifiers, symbols and file tags together', () => {
    expect(applyCodingMode('Fix camel case get user in at file user dot ts')).toBe(
      'Fix getUser in @user.ts'
    )
  })
})
