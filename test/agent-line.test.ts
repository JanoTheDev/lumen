import { describe, expect, it } from 'vitest'
import { agentLine } from '../src/renderer/src/panel/settings/sections/agent-line'

describe('agent line', () => {
  it('names the running agent', () => {
    expect(agentLine(null)).toBe('OS agent: starting')
    expect(agentLine({ impl: null, version: null, protocol: null, fallback: null })).toBe(
      'OS agent: starting'
    )
    expect(agentLine({ impl: 'native', version: '0.1.0', protocol: 2, fallback: null })).toBe(
      'OS agent: Native 0.1.0'
    )
    expect(
      agentLine({ impl: 'python', version: null, protocol: 1, fallback: 'native crashed' })
    ).toBe('OS agent: Python (fallback: native crashed)')
  })
})
