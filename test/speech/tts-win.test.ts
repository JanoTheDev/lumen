import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { OutputGate, silentOutput, ttsAllowed } from '../../src/main/speech/tts/output'
import {
  WinVoiceHelper,
  pickWinVoice,
  winRate,
  type WinVoice
} from '../../src/main/speech/tts/win-helper'

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
})

describe('winRate', () => {
  it('clamps to the WinRT range', () => {
    expect(winRate(0.25)).toBe(0.5)
    expect(winRate(1.3)).toBe(1.3)
    expect(winRate(9)).toBe(6)
    expect(winRate(NaN)).toBe(1)
  })
})

type Answer = (req: Record<string, unknown>) => Record<string, unknown> | null

/** A PowerShell stand-in: answers each JSON line with `answer(req)` (null = no reply). */
function fakeHelper(answer: Answer): {
  spawn: () => ChildProcessWithoutNullStreams
  spawned: () => number
  last: () => EventEmitter & { stdout: PassThrough }
} {
  let count = 0
  let current: (EventEmitter & { stdout: PassThrough }) | null = null
  const spawn = (): ChildProcessWithoutNullStreams => {
    count++
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: Writable
      kill: () => void
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const req = JSON.parse(line) as Record<string, unknown>
          const reply = answer(req)
          if (reply) child.stdout.write(JSON.stringify({ id: req.id, ...reply }) + '\n')
        }
        cb()
      }
    })
    child.kill = () => child.emit('exit', 0)
    current = child
    return child as unknown as ChildProcessWithoutNullStreams
  }
  return { spawn, spawned: () => count, last: () => current! }
}

describe('WinVoiceHelper', () => {
  it('synthesises with the picked voice id and clamped rate', async () => {
    const seen: Record<string, unknown>[] = []
    const f = fakeHelper((req) => {
      seen.push(req)
      if (req.op === 'voices') return { ok: true, voices: VOICES }
      if (req.op === 'synth') return { ok: true, wav: 'UklGRg==' }
      return { ok: false, error: 'nope' }
    })
    const h = new WinVoiceHelper({ spawn: f.spawn })
    await expect(h.synth('Héllo', 'Microsoft Zira - English', 0.2)).resolves.toBe('UklGRg==')
    const synth = seen.find((r) => r.op === 'synth')!
    expect(synth.voiceId).toBe('zira')
    expect(synth.rate).toBe(0.5)
    expect(Buffer.from(String(synth.text), 'base64').toString('utf8')).toBe('Héllo')
    expect(f.spawned()).toBe(1)
    h.dispose()
  })

  it('reports the output state and surfaces helper errors', async () => {
    const f = fakeHelper((req) =>
      req.op === 'output' ? { ok: true, muted: true, volume: 0.4 } : { ok: false, error: 'boom' }
    )
    const h = new WinVoiceHelper({ spawn: f.spawn })
    await expect(h.outputState(1000)).resolves.toEqual({ muted: true, volume: 0.4 })
    await expect(h.unmute()).rejects.toThrow('boom')
    h.dispose()
  })

  it('times out a request that gets no answer', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeHelper(() => null)
      const h = new WinVoiceHelper({ spawn: f.spawn })
      const p = h.outputState(300)
      const check = expect(p).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(301)
      await check
      h.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after repeated deaths before any reply', async () => {
    const f = fakeHelper(() => null)
    const h = new WinVoiceHelper({ spawn: f.spawn, maxFailures: 2 })
    for (let i = 0; i < 2; i++) {
      const p = h.outputState(5000)
      f.last().emit('exit', 1)
      await expect(p).rejects.toThrow('exited')
    }
    expect(h.usable).toBe(false)
    await expect(h.outputState(100)).rejects.toThrow('unavailable')
    expect(f.spawned()).toBe(2)
  })

  it('stops when idle and starts again on the next request', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeHelper(() => ({ ok: true, muted: false, volume: 1 }))
      const h = new WinVoiceHelper({ spawn: f.spawn, idleMs: 1000 })
      await h.outputState(500)
      await vi.advanceTimersByTimeAsync(1001)
      await h.outputState(500)
      expect(f.spawned()).toBe(2)
      h.dispose()
    } finally {
      vi.useRealTimers()
    }
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
