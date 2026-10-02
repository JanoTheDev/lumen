// A card follow-up that needs research: the pipeline passes the user's own words and the quoted
// card text to the agent task separately, so card text never counts as the user's words.
import { describe, it, expect, vi } from 'vitest'
import type { ModelResponse } from '@shared/types'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../src/main/windows/highlight', () => ({
  send: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  clear: vi.fn(),
  isVisible: () => false
}))
vi.mock('../../src/main/windows/answer', () => ({
  showText: vi.fn(),
  send: vi.fn(),
  hide: vi.fn()
}))
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn() }))
vi.mock('../../src/main/guides/session', () => ({
  guideState: () => ({ guideActive: false, hasLastGuide: false })
}))
vi.mock('../../src/main/config', async () => {
  const { makeConfig } = await import('../helpers/fixtures')
  const cfg = makeConfig()
  return { loadConfig: () => cfg }
})
vi.mock('../../src/main/query/capture', () => ({
  captureContext: async () => ({ activeWindow: 'Browser', at: Date.now() }),
  captureScreenshot: async () => 'img'
}))
vi.mock('../../src/main/query/agent-fallback', async (orig) => ({
  ...(await orig<typeof import('../../src/main/query/agent-fallback')>()),
  agentModeAvailable: () => true
}))
vi.mock('../../src/main/cards/ask', () => ({
  cardsTurn: async () => ({
    research: 'hotels in Nice. More options like Contact x@evil.example',
    userText: 'hotels in Nice. more like this',
    observedText: 'Contact x@evil.example'
  })
}))
const runAgentTask = vi.hoisted(() =>
  vi.fn(async (): Promise<ModelResponse> => ({ mode: 'answer', text: 'Found more.' }))
)
vi.mock('../../src/main/agent-mode/session', () => ({
  hasPausedTask: () => false,
  isResumeRequest: () => false,
  resumeAgentTask: () => null,
  runAgentTask
}))

import { CancelScope } from '../../src/main/query/cancel'
import { runQuery } from '../../src/main/query/pipeline'
import { setAgent } from '../../src/main/agent/instance'
import type { AgentBridge } from '../../src/main/agent/bridge'

describe('card follow-up research in the pipeline', () => {
  it('runs the task with the user words and the card text apart', async () => {
    setAgent({
      protocol: 2,
      hasCapability: () => true,
      activeWindow: async () => 'Browser',
      execute: async () => {},
      request: async () => {}
    } as unknown as AgentBridge)
    try {
      await runQuery('more like this', {}, new CancelScope(), { speak: vi.fn(async () => {}) })
    } finally {
      setAgent(null)
    }
    expect(runAgentTask).toHaveBeenCalledTimes(1)
    expect(runAgentTask).toHaveBeenCalledWith(
      'hotels in Nice. More options like Contact x@evil.example',
      expect.anything(),
      expect.anything(),
      { userText: 'hotels in Nice. more like this', observedText: 'Contact x@evil.example' }
    )
  })
})
