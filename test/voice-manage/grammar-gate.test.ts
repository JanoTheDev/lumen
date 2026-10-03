import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  normalize,
  parseManageCommand,
  parseManageWords
} from '../../src/main/voice-manage/grammar'

/** Every quoted string in the grammar and service tests. */
function testPhrases(): string[] {
  const out = new Set<string>()
  for (const file of ['grammar.test.ts', 'service.test.ts']) {
    const src = readFileSync(join(__dirname, file), 'utf8')
    for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g))
      out.add((m[1] ?? m[2]).replace(/\\(.)/g, '$1'))
  }
  return [...out]
}

function countRegExps(run: () => void): number {
  const Original = RegExp
  let count = 0
  globalThis.RegExp = new Proxy(Original, {
    construct(target, args: [string | RegExp, string?]) {
      count++
      return new target(...args)
    },
    apply(target, _this, args: [string | RegExp, string?]) {
      count++
      return target(...args)
    }
  })
  try {
    run()
  } finally {
    globalThis.RegExp = Original
  }
  return count
}

describe('first-word gate', () => {
  it('admits every phrase of the tests that the grammar takes', () => {
    const phrases = testPhrases()
    expect(phrases.length).toBeGreaterThan(150)
    let taken = 0
    for (const s of phrases) {
      const n = normalize(s)
      if (!n || n.length > 200) continue
      const cmd = parseManageWords(n)
      if (cmd) taken++
      expect(parseManageCommand(s), s).toEqual(cmd)
    }
    expect(taken).toBeGreaterThan(60)
  })

  it('admits the leading words the patterns allow', () => {
    for (const s of [
      'sign in to github',
      'signin to github',
      'log into notion',
      'login with slack',
      'get rid of the morning automation',
      'throw away my last note',
      'back up my memory',
      'dont always allow outlook',
      'do not always allow outlook',
      'no longer always allow outlook',
      'send me a bug report',
      'trigger the morning briefing now',
      'kill the email task',
      'end the email task'
    ]) {
      const cmd = parseManageWords(normalize(s))
      expect(cmd, s).not.toBeNull()
      expect(parseManageCommand(s), s).toEqual(cmd)
    }
  })

  it('builds no RegExp for an utterance that is not a command', () => {
    parseManageCommand('what is the weather like today')
    expect(countRegExps(() => parseManageCommand('what is the weather like today'))).toBe(0)
    expect(countRegExps(() => parseManageCommand('delete the email draft please'))).toBe(0)
  })
})
