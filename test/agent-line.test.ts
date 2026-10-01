import { describe, expect, it } from 'vitest'
import { agentLine } from '../src/renderer/src/panel/settings/sections/agent-line'

describe('agent line', () => {
  it('names the running agent', () => {
    expect(agentLine(null)).toBe('OS agent: starting')
    expect(agentLine({ impl: null, version: null, protocol: null, error: null })).toBe(
      'OS agent: starting'
    )
    expect(agentLine({ impl: 'native', version: '0.1.0', protocol: 2, error: null })).toBe(
      'OS agent: Native 0.1.0'
    )
  })

  it('says why the agent is not running', () => {
    expect(
      agentLine({ impl: null, version: null, protocol: null, error: 'native agent not found' })
    ).toBe('OS agent: not running (native agent not found)')
  })
})
