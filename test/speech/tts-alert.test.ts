import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
const sent = vi.hoisted(() => [] as { op: string; turnId?: string; text?: string }[])
vi.mock('../../src/main/windows/assistant', () => ({
  send: (_channel: string, msg: { op: string; turnId?: string; text?: string }) => sent.push(msg),
  setNotice: () => {},
  copyText: () => {},
  setUnmuteHandler: () => {}
}))
// No agent: Windows voices fall back to the renderer's speechSynthesis ("say" messages).
vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => null }))

import { bus } from '../../src/main/bus'
import { saveConfig, setConfigDir } from '../../src/main/config'
import { speakAlert, speakNow, speakOnce } from '../../src/main/speech/tts'
import { tempDir } from '../helpers/fixtures'

describe('one-off and alert speech (speakOnce / speakAlert)', () => {
  let tmp: ReturnType<typeof tempDir>
  beforeEach(() => {
    tmp = tempDir()
    setConfigDir(tmp.dir)
    sent.length = 0
  })
  afterEach(() => {
    bus.emit({ type: 'query.failed', turnId: 'turn-1', error: 'x' })
    setConfigDir(null)
    tmp.cleanup()
  })

  const says = (): { turnId?: string; text?: string }[] => sent.filter((m) => m.op === 'say')

  it('new configs speak with the Windows voice', () => {
    expect(speakAlert('Needs OK.')).not.toBeNull()
    expect(says().map((m) => m.text)).toEqual(['Needs OK.'])
  })

  it('"repeat that" speaks once even with spoken replies off; alerts stay quiet', () => {
    saveConfig({ voice: { tts: 'off' } } as never)
    expect(() => speakNow('x')).toThrow()
    expect(speakAlert('Error: no network')).toBeNull()
    expect(speakOnce('The capital is Paris.')).not.toBeNull()
    expect(says().map((m) => m.text)).toEqual(['The capital is Paris.'])
  })

  it('an error or confirm during a turn is queued on the turn instead of dropped', () => {
    bus.emit({ type: 'query.started', turnId: 'turn-1', prompt: 'send it' })
    expect(speakNow('dropped')).toBeNull()
    expect(speakAlert('Needs OK. Click Send. Say yes or stop.')).toBe('turn-1')
    expect(says()).toEqual([
      expect.objectContaining({ turnId: 'turn-1', text: 'Needs OK. Click Send. Say yes or stop.' })
    ])
  })
})
