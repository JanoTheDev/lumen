import { afterEach, describe, expect, it, vi } from 'vitest'

const prov = vi.hoisted(() => ({ toolTurn: undefined as unknown, throws: false }))
vi.mock('../../src/main/ai/providers', () => ({
  getProvider: () => {
    if (prov.throws) throw new Error('No API key found.')
    return { llm: { toolTurn: prov.toolTurn } }
  }
}))

import {
  agentModeAvailable,
  NO_AGENT_NOTE,
  withNoAgentNote
} from '../../src/main/query/agent-fallback'

afterEach(() => {
  prov.toolTurn = undefined
  prov.throws = false
})

describe('agent-mode fallback for local models (review med)', () => {
  it('a provider without tool use (local server) cannot run agent tasks', () => {
    expect(agentModeAvailable()).toBe(false)
    prov.toolTurn = async () => ({})
    expect(agentModeAvailable()).toBe(true)
  })

  it('no provider at all keeps the agent path (it reports the missing key)', () => {
    prov.throws = true
    expect(agentModeAvailable()).toBe(true)
  })

  it('the one-call reply carries a visible and spoken note', () => {
    const a = withNoAgentNote({ mode: 'answer', text: 'Here it is.', spoken: 'Here.' })
    expect(a).toMatchObject({
      text: `${NO_AGENT_NOTE}\n\nHere it is.`,
      spoken: `${NO_AGENT_NOTE} Here.`
    })
    const b = withNoAgentNote({ mode: 'action', actions: [] })
    expect(b).toMatchObject({ summary: NO_AGENT_NOTE })
  })
})
