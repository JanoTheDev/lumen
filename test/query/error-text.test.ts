// A failed turn's status line is spoken: plain words, and a clear one when the native agent
// is down.
import { describe, expect, it } from 'vitest'
import { AGENT_DOWN_TEXT, requireAgent, setAgent } from '../../src/main/agent/instance'
import { errorHoldMs, isAgentDown, queryErrorText } from '../../src/main/query/error-text'

describe('queryErrorText', () => {
  it('says what to do when the agent is down', () => {
    setAgent(null)
    let thrown: unknown
    try {
      requireAgent()
    } catch (e) {
      thrown = e
    }
    expect(isAgentDown(thrown)).toBe(true)
    expect(queryErrorText(thrown)).toBe(AGENT_DOWN_TEXT)
    expect(AGENT_DOWN_TEXT).toMatch(/isn't running.*Restart Lumen.*Settings, Diagnostics/)
    expect(queryErrorText({ code: 'E_AGENT_MISSING', message: 'missing exe' })).toBe(
      AGENT_DOWN_TEXT
    )
    expect(queryErrorText(new Error('Agent not running: ocr'))).toBe(AGENT_DOWN_TEXT)
  })

  it('other errors read as a sentence', () => {
    expect(queryErrorText(new Error('rate limited.'))).toBe('Something went wrong: rate limited.')
    expect(queryErrorText(null)).toBe('Something went wrong. Please try again.')
    expect(isAgentDown(new Error('timeout'))).toBe(false)
  })

  it('long lines stay up longer', () => {
    expect(errorHoldMs('x')).toBe(3000)
    expect(errorHoldMs(AGENT_DOWN_TEXT)).toBeGreaterThan(3000)
    expect(errorHoldMs('x'.repeat(1000))).toBe(10_000)
  })
})
