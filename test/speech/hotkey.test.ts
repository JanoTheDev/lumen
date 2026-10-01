import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/query/context', () => ({ startSpeculativeCapture: vi.fn() }))
vi.mock('../../src/main/query/capture', () => ({ captureContext: vi.fn() }))
vi.mock('../../src/main/windows/hud', () => ({ send: vi.fn() }))
vi.mock('../../src/main/agent/escape', () => ({ holdEscape: vi.fn(), keepEscapeWhile: vi.fn() }))
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn() }))

import { bus } from '../../src/main/bus'
import { setConfigDir } from '../../src/main/config'
import {
  captureNextHotkey,
  onAssistantHotkeyDown,
  onAssistantHotkeyUp,
  onRecordingEnded
} from '../../src/main/speech/hotkey'
import { tempDir } from '../helpers/fixtures'
import type { AppEvent } from '../../src/shared/events'

describe('assistant hotkey wiring', () => {
  let tmp: ReturnType<typeof tempDir>
  let events: AppEvent['type'][]
  let offs: Array<() => void>

  beforeEach(() => {
    tmp = tempDir()
    setConfigDir(tmp.dir)
    events = []
    offs = (['voice.started', 'voice.stopped'] as const).map((t) =>
      bus.on(t, (e) => events.push(e.type))
    )
  })
  afterEach(() => {
    for (const off of offs) off()
    onRecordingEnded()
    setConfigDir(null)
    tmp.cleanup()
  })

  it('a recording that ends in the renderer reports voice.stopped', () => {
    onRecordingEnded()
    expect(events).toEqual(['voice.stopped'])
  })

  it('the setup hotkey test consumes the press without starting a turn', async () => {
    const pressed = captureNextHotkey(5000)
    onAssistantHotkeyDown()
    onAssistantHotkeyDown()
    onAssistantHotkeyUp()
    expect(await pressed).toBe(true)
    expect(events).toEqual([])
    onAssistantHotkeyDown()
    expect(events).toEqual(['voice.started'])
  })
})
