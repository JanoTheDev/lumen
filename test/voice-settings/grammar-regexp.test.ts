import { describe, expect, it } from 'vitest'
import { parseSettingsCommand } from '../../src/main/voice-settings/grammar'

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

describe('settings grammar', () => {
  it('builds no RegExp for an utterance that is not a command', () => {
    parseSettingsCommand('what is the weather like today')
    expect(countRegExps(() => parseSettingsCommand('what is the weather like today'))).toBe(0)
  })

  it('builds no RegExp while matching a command', () => {
    expect(countRegExps(() => parseSettingsCommand('turn on dark mode in Lumen'))).toBe(0)
    expect(countRegExps(() => parseSettingsCommand('change your voice to Zira'))).toBe(0)
    expect(countRegExps(() => parseSettingsCommand('open the memory settings'))).toBe(0)
  })
})
