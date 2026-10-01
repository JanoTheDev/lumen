// The opt-in read of the focused window (T41): names only, nothing for password fields.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../../helpers/electron-mock')).electronModule())

import type { AgentBridge } from '../../../src/main/agent/bridge'
import { readScreenNames } from '../../../src/main/speech/dictation/screen-names'

function agent(doc: Record<string, unknown>, caps = true): AgentBridge {
  return {
    hasCapability: () => caps,
    request: async (cmd: string) =>
      cmd === 'focus_info' ? { title: 'Re: Plan - Priya Raman - Outlook' } : doc
  } as unknown as AgentBridge
}

describe('readScreenNames', () => {
  it('returns the names in the window text and title', async () => {
    const names = await readScreenNames(
      agent({ source: 'document', text: 'Thanks, I spoke with Jonathan about GitHub.' })
    )
    expect(names).toEqual(expect.arrayContaining(['Jonathan', 'GitHub', 'Priya', 'Raman']))
  })

  it('reads nothing from a password field or without UIA text', async () => {
    expect(await readScreenNames(agent({ source: 'password', text: '' }))).toEqual([])
    expect(await readScreenNames(agent({ source: 'document', text: 'met Alice' }, false))).toEqual(
      []
    )
  })
})
