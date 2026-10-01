import { describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
import { OutputGate, silentOutput, ttsAllowed } from '../../src/main/speech/tts/output'
import type { AgentBridge, RequestOptions } from '../../src/main/agent/bridge'
import {
  WinVoices,
  pickWinVoice,
  winRate,
  type WinVoice
} from '../../src/main/speech/tts/win-voices'

const VOICES: WinVoice[] = [
  { id: 'ar', name: 'Microsoft Naayf', lang: 'ar-SA' },
  { id: 'david', name: 'Microsoft David', lang: 'en-US' },
  { id: 'zira', name: 'Microsoft Zira', lang: 'en-US' }
]

describe('pickWinVoice', () => {
  it('matches the WinRT name and the longer Chromium name', () => {
    expect(pickWinVoice(VOICES, 'Microsoft Zira')?.id).toBe('zira')
    expect(pickWinVoice(VOICES, 'Microsoft Zira - English (United States)')?.id).toBe('zira')
  })
  it('falls back to the first English voice, then any voice', () => {
    expect(pickWinVoice(VOICES, 'alloy')?.id).toBe('david')
    expect(pickWinVoice(VOICES.slice(0, 1), '')?.id).toBe('ar')
    expect(pickWinVoice([], 'x')).toBeNull()
  })
  it('swaps a voice of another language for one of the voice language', () => {
    const es: WinVoice = { id: 'helena', name: 'Microsoft Helena', lang: 'es-ES' }
    const all = [...VOICES, es]
    expect(pickWinVoice(all, 'Microsoft Zira', 'es')?.id).toBe('helena')
    expect(pickWinVoice(all, 'Microsoft Helena', 'es')?.id).toBe('helena')
    expect(pickWinVoice(all, 'Microsoft Zira', 'en')?.id).toBe('zira')
    expect(pickWinVoice(all, 'Microsoft Zira', 'auto')?.id).toBe('zira')
    // No Spanish voice installed: keep the chosen one.
    expect(pickWinVoice(VOICES, 'Microsoft Zira', 'es')?.id).toBe('zira')
  })
})

describe('winRate', () => {
  it('clamps to the WinRT range', () => {
    expect(winRate(0.25)).toBe(0.5)
    expect(winRate(1.3)).toBe(1.3)
    expect(winRate(9)).toBe(6)
    expect(winRate(NaN)).toBe(1)
  })
})

type Reply = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

/** A stand-in for the agent bridge: answers each request with `reply`. */
function fakeAgent(
  reply: Reply,
  caps = ['tts', 'audio-output']
): {
  bridge: AgentBridge
  request: Mock<(cmd: string, args: Record<string, unknown>, opts?: RequestOptions) => unknown>
} {
  const request = vi.fn((cmd: string, args: Record<string, unknown>, opts?: RequestOptions) => {
    void opts
    return reply(cmd, args)
  })
  const bridge = { impl: 'native', hasCapability: (c: string) => caps.includes(c), request }
  return { bridge: bridge as unknown as AgentBridge, request }
}

describe('WinVoices', () => {
  it('synthesises with the picked voice id and clamped rate', async () => {
    const { bridge, request } = fakeAgent(async (cmd) =>
      cmd === 'tts_voices' ? { voices: VOICES } : { mime: 'audio/wav', data: 'UklGRg==' }
    )
    const v = new WinVoices(() => bridge)
    const ctl = new AbortController()
    await expect(v.synth('Héllo', 'Microsoft Zira - English', 0.2, ctl.signal)).resolves.toBe(
      'UklGRg=='
    )
    const call = request.mock.calls.find((c) => c[0] === 'tts_synthesize')!
    expect(call[1]).toEqual({ text: 'Héllo', voice: 'zira', rate: 0.5 })
    expect(call[2]?.signal).toBe(ctl.signal)
    await v.synth('again', '', 1)
    expect(request.mock.calls.filter((c) => c[0] === 'tts_voices')).toHaveLength(1)
  })

  it('rejects an empty answer', async () => {
    const { bridge } = fakeAgent(async (cmd) => (cmd === 'tts_voices' ? { voices: [] } : {}))
    await expect(new WinVoices(() => bridge).synth('x', '', 1)).rejects.toThrow('no audio')
  })

  it('reloads the voice list after a failure', async () => {
    let fail = true
    const { bridge, request } = fakeAgent(async () => {
      if (fail) throw new Error('boom')
      return { voices: VOICES }
    })
    const v = new WinVoices(() => bridge)
    await expect(v.voices()).rejects.toThrow('boom')
    fail = false
    await expect(v.voices()).resolves.toHaveLength(3)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('is unusable without an agent or the tts capability', async () => {
    expect(new WinVoices(() => null).usable).toBe(false)
    await expect(new WinVoices(() => null).synth('x', '', 1)).rejects.toThrow('agent')
    const { bridge } = fakeAgent(async () => ({}), ['capture'])
    const v = new WinVoices(() => bridge)
    expect(v.usable).toBe(false)
    expect(v.canCheckOutput).toBe(false)
    await expect(v.synth('x', '', 1)).rejects.toThrow('unsupported')
  })

  it('reports the output state and unmutes', async () => {
    const { bridge, request } = fakeAgent(async (cmd) =>
      cmd === 'audio_output' ? { muted: true, volume: 0.4 } : { done: true }
    )
    const v = new WinVoices(() => bridge)
    await expect(v.outputState(600)).resolves.toEqual({ muted: true, volume: 0.4 })
    expect(request.mock.calls[0][2]).toEqual({ timeoutMs: 600 })
    await v.unmute()
    expect(request.mock.calls[1][0]).toBe('audio_unmute')
  })

  it('a missing agent fails the output check without throwing synchronously', async () => {
    const gate = new OutputGate(() => new WinVoices(() => null).outputState(100), vi.fn())
    expect(await gate.mutedFor('t')).toBe(false)
  })
})

describe('OutputGate', () => {
  it('checks once per turn and reports a muted turn once', async () => {
    const check = vi.fn().mockResolvedValue({ muted: true, volume: 1 })
    const onMuted = vi.fn()
    const gate = new OutputGate(check, onMuted)
    expect(await gate.mutedFor('t1')).toBe(true)
    expect(await gate.mutedFor('t1')).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(onMuted).toHaveBeenCalledTimes(1)
    gate.forget('t1')
    await gate.mutedFor('t1')
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('treats a failed check as not muted', async () => {
    const gate = new OutputGate(() => Promise.reject(new Error('x')), vi.fn())
    expect(await gate.mutedFor('t')).toBe(false)
  })

  it('counts volume zero as silent', () => {
    expect(silentOutput({ muted: false, volume: 0 })).toBe(true)
    expect(silentOutput({ muted: false, volume: 0.3 })).toBe(false)
  })
})

describe('ttsAllowed', () => {
  it('stays quiet while a screen reader runs unless the user wants both', () => {
    expect(ttsAllowed(false, false)).toBe(true)
    expect(ttsAllowed(true, false)).toBe(false)
    expect(ttsAllowed(true, true)).toBe(true)
  })
})
