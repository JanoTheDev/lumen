import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => null }))
vi.mock('../../src/main/actions/executor', () => ({ executeActions: vi.fn() }))
vi.mock('../../src/main/agent-mode/input-lane', () => ({ withInputLane: vi.fn() }))
vi.mock('../../src/main/ipc/settings', () => ({ patchConfig: vi.fn() }))
vi.mock('../../src/main/windows/assistant', () => ({ setStatus: vi.fn() }))

import {
  TERMINAL_ENTER,
  dictateWithSpokenKeys,
  matchWhisperToggle,
  splitSpokenKey,
  type SpokenKeyDeps
} from '../../src/main/speech/spoken-keys'
import type { FocusTarget } from '../../src/main/speech/dictation/terminal-guard'

const field = (over: Partial<FocusTarget> = {}): FocusTarget => ({
  process: 'slack.exe',
  title: 'Slack',
  uia: true,
  role: 'edit',
  name: 'Message',
  editable: true,
  password: false,
  valueTail: '',
  ...over
})

function deps(over: Partial<SpokenKeyDeps> = {}): SpokenKeyDeps & {
  pressed: string[]
  statuses: string[]
} {
  const pressed: string[] = []
  const statuses: string[] = []
  return {
    pressed,
    statuses,
    spokenKeys: () => true,
    setWhisper: vi.fn(async () => {}),
    focus: async () => field(),
    pressEnter: async (t) => {
      pressed.push(t)
      return true
    },
    status: (t) => statuses.push(t),
    ...over
  }
}

describe('splitSpokenKey', () => {
  it.each([
    ['See you at five. Send it.', 'See you at five.', 'send'],
    ['see you at five, send it', 'see you at five', 'send'],
    ['see you at five and send it', 'see you at five', 'send'],
    ['Send it', '', 'send'],
    ['Thanks! Press enter.', 'Thanks!', 'enter'],
    ['ls minus la then hit return', 'ls minus la', 'enter'],
    ['That is all for now. Stop dictation.', 'That is all for now.', 'stop']
  ])('%s', (raw, text, key) => {
    expect(splitSpokenKey(raw)).toEqual({ text, key })
  })

  it.each([
    'Can you send it to me tomorrow',
    'Please send it',
    'press enter to continue',
    'I will press enter later today',
    'We stopped dictation software last year'
  ])('keeps "%s" as text', (raw) => {
    expect(splitSpokenKey(raw).key).toBeNull()
  })
})

describe('matchWhisperToggle', () => {
  it('matches whole-utterance toggles only', () => {
    expect(matchWhisperToggle('Whisper mode on.')).toBe(true)
    expect(matchWhisperToggle('turn on whisper mode')).toBe(true)
    expect(matchWhisperToggle('whisper mode off')).toBe(false)
    expect(matchWhisperToggle('Turn off whisper mode.')).toBe(false)
    expect(matchWhisperToggle('I love whisper mode on my phone')).toBeNull()
  })
})

describe('dictateWithSpokenKeys', () => {
  it('types the text, then presses Enter', async () => {
    const d = deps()
    const dictate = vi.fn(async () => ({ ok: true }))
    const r = await dictateWithSpokenKeys('Sounds good. Send it.', dictate, d)
    expect(dictate).toHaveBeenCalledWith('Sounds good.')
    expect(d.pressed).toHaveLength(1)
    expect(r.ok).toBe(true)
    expect(d.statuses).toContain('Sent')
  })

  it('never presses Enter in a terminal', async () => {
    const d = deps({ focus: async () => field({ process: 'windowsterminal.exe' }) })
    const r = await dictateWithSpokenKeys('press enter', async () => ({ ok: false }), d)
    expect(d.pressed).toHaveLength(0)
    expect(r.notice).toBe(TERMINAL_ENTER)
  })

  it('no Enter when the text did not go in as a plain insert', async () => {
    const d = deps()
    await dictateWithSpokenKeys(
      'echo hi, press enter',
      async () => ({ ok: true, notice: 'typed into a terminal' }),
      d
    )
    await dictateWithSpokenKeys('hello. Send it', async () => ({ ok: false }), d)
    expect(d.pressed).toHaveLength(0)
  })

  it('no Enter into a password field', async () => {
    const d = deps({ focus: async () => field({ password: true }) })
    await dictateWithSpokenKeys('send it', async () => ({ ok: false }), d)
    expect(d.pressed).toHaveLength(0)
  })

  it('a lone command still ends the dictation session', async () => {
    const d = deps()
    const dictate = vi.fn(async () => ({ ok: false }))
    await dictateWithSpokenKeys('Send it.', dictate, d)
    expect(dictate).toHaveBeenCalledWith('')
    expect(d.pressed).toHaveLength(1)
  })

  it('stop dictation types the rest; off passes everything through', async () => {
    const dictate = vi.fn(async () => ({ ok: true }))
    await dictateWithSpokenKeys('Done for today. Stop dictation.', dictate, deps())
    expect(dictate).toHaveBeenLastCalledWith('Done for today.')
    const off = deps({ spokenKeys: () => false })
    await dictateWithSpokenKeys('Hi. Send it.', dictate, off)
    expect(dictate).toHaveBeenLastCalledWith('Hi. Send it.')
    expect(off.pressed).toHaveLength(0)
  })

  it('whisper mode toggles instead of typing', async () => {
    const d = deps()
    const dictate = vi.fn(async () => ({ ok: false }))
    const r = await dictateWithSpokenKeys('whisper mode on', dictate, d)
    expect(d.setWhisper).toHaveBeenCalledWith(true)
    expect(dictate).toHaveBeenCalledWith('')
    expect(r).toEqual({ ok: true, notice: 'Whisper mode on' })
  })
})
